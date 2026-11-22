import { z } from 'zod';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { streamConnections } from '../observability/metrics.ts';
import type { LiveSink } from '../events/hub.ts';
import { ErrorOut, UNAUTHENTICATED, authenticate } from './exchange.ts';

/**
 * # Live push: server-sent events
 *
 * SSE rather than WebSocket: the traffic is one-way, `EventSource` reconnects
 * by itself and sends `Last-Event-ID` when it does, and it is plain HTTP — no
 * upgrade for a proxy or tunnel to mishandle.
 *
 * ## Resume without loss, without duplicates
 *
 * On connect the stream **subscribes to the hub first**, buffering, and only
 * then reads the backlog from PostgreSQL — every feed row after
 * `Last-Event-ID`. It sends the backlog, then the buffered live events whose
 * id is past the last one sent. Reading first and subscribing second would
 * lose anything committed in between; subscribing first and deduping by id
 * loses nothing and sends nothing twice.
 *
 * The backlog comes from `exchange_activity`, the durable feed, because the
 * hub keeps no history. More than `BACKLOG_LIMIT` rows behind and the server
 * sends `resync` instead: the client refetches everything over HTTP, which is
 * cheaper than streaming a long gap.
 *
 * Polling stays as the fallback: the client switches it off only while a
 * stream is open, and back on as soon as it is not.
 */

const BACKLOG_LIMIT = 200;
const HEARTBEAT_MS = 15_000;
const MAX_STREAMS_PER_INSTANCE = 2_000;

const NotificationOut = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  occurredAt: z.string(),
  createdAt: z.string(),
  read: z.boolean(),
});

export const streamRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: 'GET',
    url: '/v1/exchange/stream',
    schema: {
      tags: ['exchange'],
      summary: 'Live updates for the session: activity, notifications and market snapshots (SSE).',
      description:
        'Server-sent events. `activity` (with `id` = the event id) and `notification` are the ' +
        "session's own; `market` is the same snapshot GET /v1/exchange/market returns. " +
        'Reconnect with `Last-Event-ID` (EventSource does this itself) to resume without gaps; ' +
        '`resync` means the gap was too long and the client should refetch over HTTP. ' +
        '503 when this deployment has live push off — poll instead.',
      querystring: z.object({
        lastEventId: z
          .string()
          .regex(/^[0-9]{1,19}$/)
          .optional(),
      }),
      response: { 401: ErrorOut, 503: ErrorOut },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }
      const hub = app.live;
      if (!hub || !hub.healthy()) {
        reply.status(503);
        return { error: 'live_push_off', message: 'live push is not enabled here; poll instead' };
      }
      if (hub.connections() >= MAX_STREAMS_PER_INSTANCE) {
        reply.status(503);
        return { error: 'too_many_streams', message: 'this instance is full; poll instead' };
      }

      const header = request.headers['last-event-id'];
      const resumeRaw =
        (typeof header === 'string' ? header : undefined) ?? request.query.lastEventId;
      const resumeFrom = resumeRaw && /^[0-9]{1,19}$/.test(resumeRaw) ? BigInt(resumeRaw) : null;

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Proxies that buffer responses (nginx, some tunnels) would hold every
        // event until the buffer fills. Asking them not to is all we can do;
        // whether Cloudflare Tunnel honours it is checked at deploy time.
        'x-accel-buffering': 'no',
      });

      let closed = false;
      const write = (chunk: string) => {
        if (!closed) res.write(chunk);
      };
      const frame = (event: string, data: string, id?: string) =>
        `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${data}\n\n`;

      // 1. Subscribe first, buffering live activity until the backlog is out.
      let replaying = true;
      let lastSent = resumeFrom ?? 0n;
      const buffered: { event: string; data: string; id?: string }[] = [];
      const sink: LiveSink = {
        accountId: participant.cashAccountId.toString(),
        send: (event, data, id) => {
          if (replaying) {
            buffered.push({ event, data, ...(id ? { id } : {}) });
            return;
          }
          if (id) {
            const n = BigInt(id);
            if (n <= lastSent) return;
            lastSent = n;
          }
          write(frame(event, data, id));
        },
        close: () => {
          close();
          res.end();
        },
      };
      const unsubscribe = hub.subscribe(sink);
      streamConnections.inc();

      const heartbeat = setInterval(() => write(`: ${Date.now()}\n\n`), HEARTBEAT_MS);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        streamConnections.dec();
      };
      request.raw.on('close', close);
      res.on('error', close);

      write('retry: 3000\n\n');
      const market = hub.latestMarket();
      if (market) write(frame('market', market));

      // 2. The backlog, from the durable feed.
      try {
        if (resumeFrom !== null) {
          const { rows } = await app.pool.query<{
            outbox_event_id: bigint;
            event_type: string;
            occurred_at: string;
          }>(
            `SELECT outbox_event_id, event_type, occurred_at FROM exchange_activity
              WHERE participant_id = $1::bigint AND outbox_event_id > $2::bigint
              ORDER BY outbox_event_id
              LIMIT $3::int`,
            [participant.id.toString(), resumeFrom.toString(), BACKLOG_LIMIT + 1],
          );
          if (rows.length > BACKLOG_LIMIT) {
            write(frame('resync', JSON.stringify({ reason: 'gap too long' })));
            const newest = rows[rows.length - 1]!.outbox_event_id;
            lastSent = newest;
          } else {
            for (const r of rows) {
              write(
                frame(
                  'activity',
                  JSON.stringify({
                    id: r.outbox_event_id.toString(),
                    type: r.event_type,
                    occurredAt: r.occurred_at,
                    replayed: true,
                  }),
                  r.outbox_event_id.toString(),
                ),
              );
              lastSent = r.outbox_event_id;
            }
          }
        }
      } catch (err) {
        request.log.warn({ err }, 'stream backlog read failed; client will resync');
        write(frame('resync', JSON.stringify({ reason: 'backlog unavailable' })));
      }

      // 3. Flush what arrived meanwhile, deduped by id, then go live.
      replaying = false;
      for (const b of buffered.splice(0)) sink.send(b.event, b.data, b.id);
      return reply;
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/exchange/notifications',
    schema: {
      tags: ['exchange'],
      summary: "The session's notifications, newest first, and how many are unread.",
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }),
      response: {
        200: z.object({ unread: z.number().int(), notifications: z.array(NotificationOut) }),
        401: ErrorOut,
      },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }
      const [list, unread] = await Promise.all([
        app.pool.query<{
          id: bigint;
          kind: string;
          title: string;
          body: string | null;
          occurred_at: string;
          created_at: string;
          read_at: string | null;
        }>(
          `SELECT id, kind, title, body, occurred_at, created_at, read_at FROM notifications
            WHERE participant_id = $1::bigint ORDER BY id DESC LIMIT $2::int`,
          [participant.id.toString(), request.query.limit],
        ),
        app.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM notifications
            WHERE participant_id = $1::bigint AND read_at IS NULL`,
          [participant.id.toString()],
        ),
      ]);
      return {
        unread: unread.rows[0]!.n,
        notifications: list.rows.map((r) => ({
          id: r.id.toString(),
          kind: r.kind,
          title: r.title,
          body: r.body,
          occurredAt: r.occurred_at,
          createdAt: r.created_at,
          read: r.read_at !== null,
        })),
      };
    },
  });

  app.route({
    method: 'POST',
    url: '/v1/exchange/notifications/read',
    schema: {
      tags: ['exchange'],
      summary: 'Mark notifications read, up to and including `upTo`.',
      body: z.object({ upTo: z.string().regex(/^[0-9]{1,19}$/) }).strict(),
      response: { 200: z.object({ marked: z.number().int() }), 401: ErrorOut },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }
      const { rowCount } = await app.pool.query(
        `UPDATE notifications SET read_at = now()
          WHERE participant_id = $1::bigint AND id <= $2::bigint AND read_at IS NULL`,
        [participant.id.toString(), request.body.upTo],
      );
      return { marked: rowCount ?? 0 };
    },
  });
};
