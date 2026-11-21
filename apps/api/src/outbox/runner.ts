import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { allShards, drainOnce, reap, reclaimStale, type Publisher } from './worker.ts';

/**
 * # The outbox worker, running
 *
 * `worker.ts` is the mechanism — claim, publish, settle. This file is the loop
 * that calls it, and the one publisher this deployment has: the exchange's
 * activity feed.
 *
 * ## One instance
 *
 * The loop owns all sixteen shards. Two API instances both running it would
 * not double-publish — `FOR UPDATE SKIP LOCKED` sees to that, and the feed is
 * idempotent anyway — but they would split one account's events between two
 * workers and so give up per-account ordering. A second instance should be
 * started with the worker off, or the shards divided with `shardsFor()`.
 */

/**
 * Publish an event into `exchange_activity`.
 *
 * The consumer is idempotent by construction: `UNIQUE (outbox_event_id)` with
 * `ON CONFLICT DO NOTHING`. Delivery is at-least-once, so the same event can
 * arrive twice — after a crash between publishing and settling — and the second
 * arrival is a no-op.
 *
 * An event for an account that is not a participant's cash account (a legacy
 * customer, say) inserts nothing and is still published: this feed has no
 * reader for it, and leaving it pending would stall its shard.
 */
export const activityPublisher =
  (pool: pg.Pool): Publisher =>
  async (event) => {
    await pool.query(
      `INSERT INTO exchange_activity
         (participant_id, outbox_event_id, event_type, payload, occurred_at)
       SELECT p.id, o.id, o.event_type, o.payload, o.created_at
         FROM outbox o
         JOIN participants p ON p.cash_account_id = o.account_id
        WHERE o.id = $1::bigint
       ON CONFLICT (outbox_event_id) DO NOTHING`,
      [event.id.toString()],
    );
  };

export interface OutboxRunnerOptions {
  pollIntervalMs: number;
  log: FastifyBaseLogger;
}

export interface OutboxRunner {
  /** Stop polling and wait for the cycle in progress. */
  stop: () => Promise<void>;
}

/** Housekeeping — reclaim and reap — runs once per this many poll cycles. */
const HOUSEKEEPING_EVERY = 60;

export function startOutboxWorker(pool: pg.Pool, options: OutboxRunnerOptions): OutboxRunner {
  const { log, pollIntervalMs } = options;
  const workerId = `api-${String(process.pid)}`;
  const publish = activityPublisher(pool);

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let cycles = 0;

  const cycle = async (): Promise<number> => {
    cycles += 1;

    if (cycles % HOUSEKEEPING_EVERY === 1) {
      const reclaimed = await reclaimStale(pool);
      const reaped = await reap(pool);
      if (reclaimed > 0 || reaped > 0) log.info({ reclaimed, reaped }, 'outbox housekeeping');
    }

    const result = await drainOnce({ pool, publish, shards: allShards(), workerId });
    if (result.dead > 0) log.error({ dead: result.dead }, 'outbox events dead-lettered');
    return result.claimed;
  };

  /**
   * `setTimeout` re-armed after each cycle, not `setInterval`, so a slow
   * database makes the worker slower instead of stacking cycles. A full batch
   * polls again at once: there is probably more behind it.
   */
  const schedule = (delayMs: number): void => {
    if (stopped) return;

    timer = setTimeout(() => {
      timer = null;
      inFlight = cycle()
        .then((claimed) => (claimed >= 25 ? 0 : pollIntervalMs))
        .catch((err: unknown) => {
          // Caught, always: `server.ts` exits on an unhandled rejection, and a
          // database blip must not take the API down with the worker.
          log.warn({ err }, 'outbox cycle failed');
          return 4 * pollIntervalMs;
        })
        .then((nextDelayMs) => schedule(nextDelayMs));
    }, delayMs);
  };

  log.info({ worker_id: workerId, poll_interval_ms: pollIntervalMs }, 'outbox worker started');
  schedule(0);

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
