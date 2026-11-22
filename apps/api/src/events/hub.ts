import { randomBytes } from 'node:crypto';
import type { MessagesStream } from '@platformatic/kafka';
import type { FastifyBaseLogger } from 'fastify';
import { decodeEnvelope } from './envelope.ts';
import { createAdmin, createConsumer, type KafkaConfig, type StringConsumer } from './kafka.ts';
import type { TopicNames } from './topics.ts';

/**
 * # The live hub, one per API instance
 *
 * Reads three topics and fans each message out to the streams open on **this**
 * instance:
 *
 * - `events`        → the guest whose account it is (`activity`)
 * - `notifications` → likewise (`notification`)
 * - `market`        → everyone (`market`)
 *
 * Every instance must see every message — a guest's stream can be on any of
 * them — so each instance joins with a **group of its own**, starting from
 * `latest`, and never commits. History is not this component's job: a stream
 * that reconnects resumes from PostgreSQL (`Last-Event-ID` → the activity
 * feed), and only then goes live from here. The group is deleted on shutdown
 * so the broker does not accumulate one dead group per deploy.
 *
 * Nothing here is a guarantee. A message this hub misses — it was restarting,
 * a slow client's buffer was full — costs latency: the client's next poll or
 * reconnect reads the durable copy.
 */

export interface LiveSink {
  /** Account the stream belongs to, as a decimal string. */
  accountId: string;
  send: (event: string, data: string, id?: string) => void;
  /** End the stream: the client falls back to polling and reconnects later. */
  close: () => void;
}

export interface LiveHub {
  subscribe: (sink: LiveSink) => () => void;
  /** Latest market snapshot, for a stream's first frame. */
  latestMarket: () => string | null;
  /**
   * Whether the hub is reading the broker right now. A stream opened while it
   * is not would look live and deliver nothing — the client would stop polling
   * for no reason — so the route refuses with 503 instead.
   */
  healthy: () => boolean;
  connections: () => number;
  stop: () => Promise<void>;
}

export function startLiveHub(
  kafka: KafkaConfig,
  topics: TopicNames,
  namespace: string,
  log: FastifyBaseLogger,
): LiveHub {
  const byAccount = new Map<string, Set<LiveSink>>();
  const all = new Set<LiveSink>();
  let latest: string | null = null;
  let stopped = false;
  let healthy = false;
  let consumer: StringConsumer | null = null;
  let stream: MessagesStream<string, string, string, string> | null = null;
  const groupId = `${namespace}.live.${randomBytes(6).toString('hex')}`;

  const deliver = (topic: string, value: string | undefined): void => {
    if (value === undefined) return;
    if (topic === topics.market) {
      latest = value;
      for (const sink of all) sink.send('market', value);
      return;
    }
    if (topic === topics.notifications) {
      let accountId: string | undefined;
      try {
        accountId = (JSON.parse(value) as { accountId?: string }).accountId;
      } catch {
        return;
      }
      if (!accountId) return;
      for (const sink of byAccount.get(accountId) ?? []) sink.send('notification', value);
      return;
    }
    // events
    let event;
    try {
      event = decodeEnvelope(value);
    } catch {
      return;
    }
    const sinks = byAccount.get(event.accountId.toString());
    if (!sinks || sinks.size === 0) return;
    const data = JSON.stringify({
      id: event.eventId.toString(),
      type: event.type,
      occurredAt: event.occurredAt,
      relayedAt: new Date().toISOString(),
    });
    for (const sink of sinks) sink.send('activity', data, event.eventId.toString());
  };

  const loop = async (): Promise<void> => {
    let restarts = 0;
    while (!stopped) {
      try {
        consumer = createConsumer({ ...kafka, clientId: `${kafka.clientId}-live`, groupId });
        stream = await consumer.consume({
          topics: [topics.events, topics.notifications, topics.market],
          mode: 'latest',
        });
        restarts = 0;
        healthy = true;
        log.info({ group: groupId }, 'live hub consuming');
        for await (const message of stream) {
          if (stopped) break;
          deliver(message.topic, message.value);
        }
      } catch (err) {
        if (stopped) break;
        restarts += 1;
        log.warn({ err, restarts }, 'live hub stream failed; restarting');
      } finally {
        healthy = false;
        // Every open stream is now silent. Ending them puts their clients
        // back on polling at once instead of showing "live" with nothing
        // arriving; EventSource reconnects, and gets 503 until we are back.
        for (const sink of [...all]) sink.close();
        await stream?.close().catch(() => undefined);
        await consumer?.close().catch(() => undefined);
        stream = null;
        consumer = null;
      }
      if (!stopped)
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** restarts)));
    }
  };
  const running = loop();

  return {
    subscribe(sink) {
      all.add(sink);
      const set = byAccount.get(sink.accountId) ?? new Set<LiveSink>();
      set.add(sink);
      byAccount.set(sink.accountId, set);
      return () => {
        all.delete(sink);
        set.delete(sink);
        if (set.size === 0) byAccount.delete(sink.accountId);
      };
    },
    latestMarket: () => latest,
    healthy: () => healthy,
    connections: () => all.size,
    stop: async () => {
      stopped = true;
      await stream?.close().catch(() => undefined);
      await running;
      const admin = createAdmin({ ...kafka, clientId: `${kafka.clientId}-live-admin` });
      try {
        await admin.deleteGroups({ groups: [groupId] });
      } catch {
        /* the broker expires empty groups on its own; this is tidiness */
      } finally {
        await admin.close().catch(() => undefined);
      }
    },
  };
}
