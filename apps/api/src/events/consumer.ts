import { setTimeout as sleep } from 'node:timers/promises';
import type { Message, MessagesStream } from '@platformatic/kafka';
import type { Logger } from 'pino';
import type pg from 'pg';
import { consumerLagSeconds, consumerMessages } from '../observability/metrics.ts';
import { decodeEnvelope, type Envelope } from './envelope.ts';
import {
  createConsumer,
  type KafkaConfig,
  type StringConsumer,
  type StringProducer,
} from './kafka.ts';
import type { ConsumerName, TopicNames } from './topics.ts';

/**
 * # Running a consumer
 *
 * Every consumer of the events topic goes through this file, so the delivery
 * rules are implemented once:
 *
 * 1. **At-least-once.** The offset is committed only after the message's
 *    effect is durable. A crash between the two redelivers the message.
 * 2. **Idempotent by a Postgres key.** A *transactional* consumer's effect and
 *    its `consumer_receipts (consumer, event_id)` row commit in one
 *    transaction, so "already applied" is a fact in the same database as the
 *    effect. Kafka's offsets are a progress hint; the receipt is the guarantee.
 * 3. **A poison message is parked, not retried forever.** One message that
 *    always fails would otherwise stop its partition — and with it every other
 *    account keyed there. After `POISON_ATTEMPTS` it goes to the DLQ topic and
 *    `consumer_dead_letters`, and the offset moves past it.
 * 4. **An outage is not poison.** A database or Valkey that cannot be reached
 *    fails every message, and dead-lettering through an outage would empty the
 *    topic into the DLQ. Transient errors retry indefinitely, with backoff, on
 *    the same message.
 *
 * Messages are handled **one at a time, in stream order**. Per-account order
 * is the property the whole pipeline preserves, and concurrent handling would
 * throw it away at the last step.
 */

/** Applied inside a transaction that also writes the receipt. */
export type TransactionalHandler = (client: pg.PoolClient, event: Envelope) => Promise<void>;

/**
 * Applied outside any transaction — a BullMQ `add()`, say. Must itself be
 * idempotent (a deterministic job id, and a Postgres guard where the job runs).
 */
export type SideEffectHandler = (event: Envelope) => Promise<void>;

export interface ConsumerSpec {
  name: ConsumerName;
  groupId: string;
  /** Event types this consumer cares about; anything else is committed past. */
  types: (type: string) => boolean;
  /**
   * Where a group with no committed offset starts. `earliest` for a
   * projection, which needs history; `latest` for something like the notifier,
   * which must not notify about last month on its first deploy.
   */
  startFrom: 'earliest' | 'latest';
  handler:
    | { kind: 'transactional'; apply: TransactionalHandler }
    | { kind: 'side-effect'; run: SideEffectHandler };
}

export interface RunConsumerOptions {
  pool: pg.Pool;
  kafka: KafkaConfig;
  topics: TopicNames;
  /** Used for the DLQ. Shared with the relay; never closed here. */
  producer: StringProducer;
  log: Logger;
}

export interface RunningConsumer {
  stop: () => Promise<void>;
}

const POISON_ATTEMPTS = 5;

/**
 * Errors that describe the environment, not the message: retry the same
 * message until the environment recovers.
 */
export function isTransient(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; name?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';

  // SQLSTATE class 08 (connection exception), 57P01-03 (admin shutdown, crash
  // shutdown, cannot connect now), 53300 (too many connections), 40001/40P01
  // (serialization failure / deadlock — retrying is the documented remedy).
  if (/^08/.test(code) || /^57P0[123]$/.test(code)) return true;
  if (code === '53300' || code === '40001' || code === '40P01') return true;
  if (
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
  ) {
    return true;
  }
  if (code.startsWith('PLT_KFK_') && code !== 'PLT_KFK_USER') return true;
  return /Connection terminated|timeout exceeded when trying to connect|Connection is closed|ECONNREFUSED/i.test(
    message,
  );
}

const describe = (err: unknown): string =>
  (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 1000);

/** Apply one event transactionally. Returns whether it was new. */
async function applyTransactional(
  pool: pg.Pool,
  consumer: ConsumerName,
  event: Envelope,
  apply: TransactionalHandler,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `INSERT INTO consumer_receipts (consumer, event_id) VALUES ($1, $2::bigint)
       ON CONFLICT DO NOTHING`,
      [consumer, event.eventId.toString()],
    );
    if (rowCount === 0) {
      // Seen before. Nothing to apply; the offset can move.
      await client.query('ROLLBACK');
      return false;
    }
    await apply(client, event);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function deadLetter(
  options: RunConsumerOptions,
  spec: ConsumerSpec,
  message: Message<string, string, string, string>,
  eventId: bigint | null,
  error: unknown,
): Promise<void> {
  const detail = describe(error);

  // The Kafka copy first: it carries the original bytes for a replay tool.
  // Then the Postgres row, which is what a human and the alert look at.
  await options.producer.send({
    messages: [
      {
        topic: options.topics.eventsDlq,
        key: message.key,
        value: message.value,
        headers: {
          'dlq-consumer': spec.name,
          'dlq-source': `${message.topic}/${String(message.partition)}/${message.offset.toString()}`,
          'dlq-error': detail.slice(0, 200),
        },
      },
    ],
  });

  await options.pool.query(
    `INSERT INTO consumer_dead_letters
       (consumer, topic, partition, "offset", event_id, error, raw_value)
     VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6, $7)
     ON CONFLICT (consumer, topic, partition, "offset") DO NOTHING`,
    [
      spec.name,
      message.topic,
      message.partition,
      message.offset.toString(),
      eventId === null ? null : eventId.toString(),
      detail,
      (message.value ?? '').slice(0, 100_000),
    ],
  );
}

/**
 * Handle one message to completion: applied, skipped, duplicate, or parked.
 * Only returns once it is safe to commit the offset. Rejects only when the
 * consumer is stopping.
 */
async function handleMessage(
  options: RunConsumerOptions,
  spec: ConsumerSpec,
  message: Message<string, string, string, string>,
  isStopped: () => boolean,
): Promise<void> {
  const { log } = options;

  let event: Envelope;
  try {
    event = decodeEnvelope(message.value);
  } catch (err) {
    // Undecodable bytes never become decodable: straight to the DLQ.
    await withTransientRetry(() => deadLetter(options, spec, message, null, err), log, isStopped);
    consumerMessages.inc({ consumer: spec.name, outcome: 'dead' });
    log.error({ consumer: spec.name, err }, 'undecodable message dead-lettered');
    return;
  }

  if (!spec.types(event.type)) {
    consumerMessages.inc({ consumer: spec.name, outcome: 'skipped' });
    return;
  }

  let failures = 0;
  let outages = 0;
  for (;;) {
    if (isStopped()) throw new Error('consumer stopping');
    try {
      let applied = true;
      if (spec.handler.kind === 'transactional') {
        applied = await applyTransactional(options.pool, spec.name, event, spec.handler.apply);
      } else {
        await spec.handler.run(event);
      }
      consumerMessages.inc({ consumer: spec.name, outcome: applied ? 'applied' : 'duplicate' });
      const ageMs = Date.now() - Date.parse(event.occurredAt);
      if (applied && Number.isFinite(ageMs)) {
        consumerLagSeconds.observe({ consumer: spec.name }, Math.max(0, ageMs) / 1000);
      }
      return;
    } catch (err) {
      const transient = isTransient(err);
      if (transient) outages += 1;
      else failures += 1;

      if (failures >= POISON_ATTEMPTS) {
        await withTransientRetry(
          () => deadLetter(options, spec, message, event.eventId, err),
          log,
          isStopped,
        );
        consumerMessages.inc({ consumer: spec.name, outcome: 'dead' });
        log.error(
          { consumer: spec.name, event_id: event.eventId, event_type: event.type, err },
          'poison message dead-lettered',
        );
        return;
      }

      const delay = transient
        ? Math.min(30_000, 500 * 2 ** Math.min(outages, 6))
        : 100 * 2 ** failures;
      log.warn(
        { consumer: spec.name, event_id: event.eventId, transient, failures, outages, err },
        'consumer handler failed; retrying the same message',
      );
      await sleep(delay);
    }
  }
}

async function withTransientRetry(
  work: () => Promise<void>,
  log: Logger,
  isStopped: () => boolean,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (isStopped()) throw new Error('consumer stopping');
    try {
      await work();
      return;
    } catch (err) {
      log.warn({ err, attempt }, 'dead-letter write failed; retrying');
      await sleep(Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)));
    }
  }
}

/**
 * Start a supervised consumer. If the broker goes away the stream errors; the
 * supervisor closes the client and starts a new one with backoff, resuming
 * from the last committed offset — which, by rule 1, is never past an effect
 * that did not happen.
 */
export function runConsumer(options: RunConsumerOptions, spec: ConsumerSpec): RunningConsumer {
  const log = options.log.child({ consumer: spec.name });
  let stopped = false;
  let consumer: StringConsumer | null = null;
  let stream: MessagesStream<string, string, string, string> | null = null;
  const isStopped = () => stopped;

  const loop = async (): Promise<void> => {
    let restarts = 0;
    while (!stopped) {
      try {
        consumer = createConsumer({
          ...options.kafka,
          clientId: `${options.kafka.clientId}-${spec.name}`,
          groupId: spec.groupId,
        });
        stream = await consumer.consume({
          topics: [options.topics.events],
          mode: 'committed',
          fallbackMode: spec.startFrom,
        });
        log.info({ group: spec.groupId }, 'consumer started');
        restarts = 0;

        for await (const message of stream) {
          if (stopped) break;
          await handleMessage(options, spec, message, isStopped);
          await message.commit();
        }
      } catch (err) {
        if (stopped) break;
        restarts += 1;
        log.warn({ err, restarts }, 'consumer stream failed; restarting');
      } finally {
        await stream?.close().catch(() => undefined);
        await consumer?.close().catch(() => undefined);
        stream = null;
        consumer = null;
      }
      if (!stopped) await sleep(Math.min(30_000, 1_000 * 2 ** Math.min(restarts, 5)));
    }
  };

  const running = loop();

  return {
    stop: async () => {
      stopped = true;
      // Ending the stream ends the `for await`; the message in progress either
      // finishes (and commits) or rejects with "consumer stopping" before
      // committing, and is redelivered to the next owner of the partition.
      await stream?.close().catch(() => undefined);
      await running;
    },
  };
}
