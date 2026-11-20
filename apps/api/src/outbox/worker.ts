import type pg from 'pg';

/**
 * # The outbox worker
 *
 * ## Claim → commit → publish, and never publish while holding the lock
 *
 * The sequence is three separate steps on purpose:
 *
 *   1. **claim** — one short transaction marks rows `in_flight` and commits
 *   2. **publish** — the network call, with no transaction open at all
 *   3. **settle** — a second short transaction marks the result
 *
 * The tempting shortcut is to do all three inside one transaction, so that a
 * publish failure rolls the claim back. It is a trap:
 *
 * - The row lock is held for the consumer's latency. One slow consumer pins a
 *   connection-pool slot per in-flight event.
 * - An open transaction holds back `VACUUM`'s cleanup horizon. A long one stops
 *   dead tuples being reclaimed **across the whole database**, not just this
 *   table, so a sluggish broker slowly bloats the ledger.
 * - It buys nothing. The publish is to another system, so the rollback cannot
 *   un-send it. If the publish succeeded and the commit then failed, the event
 *   is still delivered and the row still says pending.
 *
 * That last point is the real one: **delivery is at-least-once and cannot be
 * made exactly-once here.** The worker can publish and then die before
 * settling, and the next poll republishes. Consumers must be idempotent —
 * Phase 4's webhook endpoint is the worked example of one that is.
 */

export interface OutboxEvent {
  id: bigint;
  transactionId: bigint;
  accountId: bigint;
  eventType: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  shard: number;
}

/** What a publisher must satisfy. Deliberately tiny. */
export type Publisher = (event: OutboxEvent) => Promise<void>;

export interface WorkerOptions {
  pool: pg.Pool;
  publish: Publisher;
  /**
   * Which shards this worker owns.
   *
   * **The ordering guarantee lives here.** `FOR UPDATE SKIP LOCKED` lets N
   * workers share a queue but does *not* preserve per-account order: two events
   * for one account get claimed by two workers, and whichever network call
   * returns first publishes first. Assigning each account to exactly one worker
   * — via `shard = account_id % 16` — makes two events for one account always
   * claimed by the same worker, in id order.
   *
   * Across accounts there is no ordering guarantee and none is claimed.
   */
  shards: number[];
  /** Identifies this worker in `claimed_by`, for diagnosing a stuck shard. */
  workerId: string;
  /** Rows per claim. */
  batchSize?: number;
}

export const SHARD_COUNT = 16;

/** Every shard, for a single-worker deployment. */
export const allShards = (): number[] => Array.from({ length: SHARD_COUNT }, (_, i) => i);

/**
 * Which shards worker `index` of `total` owns.
 *
 * Deterministic and gap-free: every shard is owned by exactly one worker, so no
 * event is orphaned and none is claimed twice.
 */
export function shardsFor(index: number, total: number): number[] {
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 0) {
    throw new RangeError('shard assignment needs non-negative index and positive total');
  }
  if (index >= total)
    throw new RangeError(`worker index ${String(index)} >= total ${String(total)}`);

  return allShards().filter((shard) => shard % total === index);
}

/**
 * Write an outbox row. Call this **inside** the ledger transaction.
 *
 * Takes a `client`, not a pool, and that is the entire point of the pattern: the
 * event and the entries it describes commit or roll back together. Passing a
 * pool here would reintroduce the dual write this table exists to eliminate,
 * which is why the signature makes it impossible.
 */
export async function enqueue(
  client: pg.PoolClient,
  event: {
    transactionId: bigint;
    accountId: bigint;
    eventType: string;
    payload: unknown;
  },
): Promise<bigint> {
  const { rows } = await client.query<{ id: bigint }>(
    `INSERT INTO outbox (transaction_id, account_id, event_type, payload)
     VALUES ($1::bigint, $2::bigint, $3, $4::jsonb)
     RETURNING id`,
    [
      event.transactionId.toString(),
      event.accountId.toString(),
      event.eventType,
      JSON.stringify(event.payload ?? null),
    ],
  );
  return rows[0]!.id;
}

/**
 * Step 1: claim a batch, in its own short transaction, and commit immediately.
 *
 * `FOR UPDATE SKIP LOCKED` so two workers polling the same shard (which should
 * not happen, but might during a rolling deploy) do not block each other.
 *
 * `ORDER BY id` within the shard is what delivers per-account order: ids are
 * monotonic from an identity column, so the oldest event for an account is
 * always claimed first.
 */
export async function claimBatch(options: WorkerOptions): Promise<OutboxEvent[]> {
  const batchSize = options.batchSize ?? 25;
  const client = await options.pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{
      id: bigint;
      transaction_id: bigint;
      account_id: bigint;
      event_type: string;
      payload: unknown;
      attempts: number;
      max_attempts: number;
      shard: number;
    }>(
      `WITH claimed AS (
         SELECT id FROM outbox
          WHERE state = 'pending'
            AND shard = ANY($1::smallint[])
            AND available_at <= now()
          ORDER BY id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox o
          SET state = 'in_flight',
              claimed_at = now(),
              claimed_by = $3,
              attempts = o.attempts + 1
         FROM claimed c
        WHERE o.id = c.id
        RETURNING o.id, o.transaction_id, o.account_id, o.event_type, o.payload,
                  o.attempts, o.max_attempts, o.shard`,
      [options.shards, batchSize, options.workerId],
    );

    // Committed BEFORE any publish. From here the rows are this worker's
    // responsibility and no lock is held.
    await client.query('COMMIT');

    return (
      rows
        .map((r) => ({
          id: r.id,
          transactionId: r.transaction_id,
          accountId: r.account_id,
          eventType: r.event_type,
          payload: r.payload,
          attempts: r.attempts,
          maxAttempts: r.max_attempts,
          shard: r.shard,
        }))
        // Re-sorted defensively: the UPDATE ... FROM above has no guaranteed
        // output order, and the ordering guarantee must not depend on one.
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Exponential backoff with full jitter, in seconds. Capped. */
function backoffSeconds(attempts: number): number {
  const base = 2;
  const cap = 300;
  return Math.random() * Math.min(cap, base ** Math.min(attempts, 10));
}

/** Step 3a: the publish succeeded. */
export async function markPublished(pool: pg.Pool, id: bigint): Promise<void> {
  await pool.query(
    `UPDATE outbox SET state = 'published', published_at = now(),
            claimed_at = NULL, claimed_by = NULL
      WHERE id = $1::bigint`,
    [id.toString()],
  );
}

/**
 * Step 3b: the publish failed.
 *
 * Back to `pending` with a backoff, or to `dead` once `max_attempts` is reached.
 * Dead rows are **never** retried automatically: a poison message retried
 * forever is how a queue stops delivering anything else, and the only honest
 * response is to park it where a human will see it.
 */
export async function markFailed(
  pool: pg.Pool,
  event: OutboxEvent,
  error: unknown,
): Promise<'retry' | 'dead'> {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const exhausted = event.attempts >= event.maxAttempts;

  if (exhausted) {
    await pool.query(
      `UPDATE outbox SET state = 'dead', last_error = $2,
              claimed_at = NULL, claimed_by = NULL
        WHERE id = $1::bigint`,
      [event.id.toString(), detail],
    );
    return 'dead';
  }

  await pool.query(
    `UPDATE outbox SET state = 'pending', last_error = $2,
            available_at = now() + ($3 || ' seconds')::interval,
            claimed_at = NULL, claimed_by = NULL
      WHERE id = $1::bigint`,
    [event.id.toString(), detail, backoffSeconds(event.attempts).toFixed(3)],
  );
  return 'retry';
}

export interface DrainResult {
  claimed: number;
  published: number;
  retried: number;
  dead: number;
}

/**
 * One poll cycle: claim, publish each, settle each.
 *
 * Events are published **sequentially within a shard batch**, not with
 * `Promise.all`. Parallelising here would discard the ordering guarantee the
 * sharding exists to provide: two events for one account would be in flight at
 * once and could land out of order, which is exactly the failure
 * `FOR UPDATE SKIP LOCKED` fan-out produces and this design avoids.
 */
export async function drainOnce(options: WorkerOptions): Promise<DrainResult> {
  const events = await claimBatch(options);
  const result: DrainResult = { claimed: events.length, published: 0, retried: 0, dead: 0 };

  for (const event of events) {
    try {
      // No transaction is open here. This is the whole point.
      await options.publish(event);
      await markPublished(options.pool, event.id);
      result.published += 1;
    } catch (err) {
      const outcome = await markFailed(options.pool, event, err);
      if (outcome === 'dead') result.dead += 1;
      else result.retried += 1;
    }
  }

  return result;
}

/**
 * Reclaim rows left `in_flight` by a worker that died mid-publish.
 *
 * Without this they sit in_flight forever and that account's shard stops
 * progressing — the ordering guarantee means the next event for the account
 * cannot overtake it. Reclaiming is safe precisely because delivery is
 * at-least-once: republishing an event the dead worker may already have sent is
 * acceptable, and the consumer's idempotency is what makes it so.
 */
export async function reclaimStale(pool: pg.Pool, olderThanSeconds = 300): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE outbox
        SET state = 'pending', claimed_at = NULL, claimed_by = NULL,
            available_at = now()
      WHERE state = 'in_flight'
        AND claimed_at < now() - ($1 || ' seconds')::interval`,
    [String(olderThanSeconds)],
  );
  return rowCount ?? 0;
}

/**
 * The reaper. "Mark done" with no cleanup means the table grows forever.
 *
 * Only `published` rows are deleted. `dead` rows are kept until a human deals
 * with them — deleting an undelivered event to tidy a table is how a system
 * quietly loses data.
 */
export async function reap(pool: pg.Pool, olderThanHours = 24): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM outbox
      WHERE state = 'published'
        AND published_at < now() - ($1 || ' hours')::interval`,
    [String(olderThanHours)],
  );
  return rowCount ?? 0;
}

export interface OutboxLag {
  pending: bigint;
  inFlight: bigint;
  dead: bigint;
  oldestUnpublishedSeconds: bigint;
  staleClaims: bigint;
}

/** The number to alert on: the age of the oldest unpublished event. */
export async function lag(pool: pg.Pool): Promise<OutboxLag> {
  const { rows } = await pool.query<{
    pending: bigint;
    in_flight: bigint;
    dead: bigint;
    oldest_unpublished_seconds: bigint;
    stale_claims: bigint;
  }>('SELECT * FROM outbox_lag');

  const r = rows[0]!;
  return {
    pending: r.pending,
    inFlight: r.in_flight,
    dead: r.dead,
    oldestUnpublishedSeconds: r.oldest_unpublished_seconds,
    staleClaims: r.stale_claims,
  };
}

/**
 * **The dual-write bug, runnable.**
 *
 * This is what the outbox replaces: commit the ledger transaction, then publish
 * separately. There is no atomicity across the two, so a process killed between
 * them loses the event permanently — the money has moved and nothing downstream
 * will ever hear about it.
 *
 * `killBetween` is the demonstration seam. In production the same window is a
 * SIGKILL, an OOM, a node eviction, or a network partition; the probability is
 * low per request and certain at volume.
 *
 * Kept permanently, like every other naive path here.
 */
export async function publishAfterCommitNaive(options: {
  pool: pg.Pool;
  publish: Publisher;
  event: Omit<OutboxEvent, 'id' | 'attempts' | 'maxAttempts' | 'shard'>;
  /** Awaited after the commit and before the publish. Throw to simulate a crash. */
  killBetween?: () => Promise<void>;
}): Promise<void> {
  const client = await options.pool.connect();
  try {
    await client.query('BEGIN');
    // Stand-in for the ledger write. The real one is `post()`.
    await client.query('SELECT 1');
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  // ---- THE WINDOW ----
  // The transaction is committed. Nothing records that an event is owed.
  if (options.killBetween) await options.killBetween();

  await options.publish({
    ...options.event,
    id: 0n,
    attempts: 0,
    maxAttempts: 1,
    shard: Number(options.event.accountId % BigInt(SHARD_COUNT)),
  });
}
