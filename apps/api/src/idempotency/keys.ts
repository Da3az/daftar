import { createHash } from 'node:crypto';
import type pg from 'pg';

/**
 * # `Idempotency-Key` on a write endpoint
 *
 * The duplicate source is a **client or proxy retry**: a timeout on a request
 * that actually succeeded, a mobile network retransmitting, a load balancer
 * retrying a 502. The client sends a key; the same key must produce the same
 * outcome and must not do the work twice.
 *
 * ## Enforced by a UNIQUE index, never by a lookup
 *
 * The shape everyone writes first:
 *
 * ```ts
 * const existing = await db.find(key);     // (1)
 * if (existing) return existing.response;
 * const order = await doTheWork();          // (2)
 * await db.insert(key, order);              // (3)
 * ```
 *
 * This is Phase 1's lost-update race wearing different clothes. Two concurrent
 * retries both reach (1) and find nothing, both run (2), and the customer is
 * charged twice. No isolation level saves it, because nothing in the database
 * knows the two requests are related until (3) — by which point both have
 * already done the work.
 *
 * The correct shape makes the database arbitrate **before** the work happens:
 *
 * ```sql
 * INSERT INTO idempotency_keys (...) VALUES (...)
 * ON CONFLICT (route, key) DO NOTHING
 * RETURNING id
 * ```
 *
 * Exactly one caller gets a row. That caller owns the request. Everyone else
 * reads what it recorded.
 *
 * Both paths are in this file, selected per request by
 * `DAFTAR_NAIVE_IDEMPOTENCY`, because a described race is marketing.
 */

export type ClaimOutcome =
  /** This caller owns the request and must do the work, then settle the key. */
  | { status: 'claimed'; id: bigint }
  /**
   * Already completed. Replay the recorded response verbatim — including its
   * status code, which is the part people forget.
   */
  | { status: 'replay'; responseStatus: number; responseBody: unknown }
  /**
   * Another request holds the key and is still working.
   *
   * **Returns 409, not 200.** The shortcut of answering 200 here is the bug this
   * phase exists to avoid: the work may still fail, so success has not happened
   * and reporting it is a lie that the client will act on.
   */
  | { status: 'in_progress' }
  /**
   * The key was used before with a *different* request body. The client has a
   * bug; replaying an unrelated response would hide it.
   */
  | { status: 'mismatch'; expectedHash: string; actualHash: string };

/**
 * SHA-256 over the canonical JSON of the request body.
 *
 * Keys are sorted so that `{"a":1,"b":2}` and `{"b":2,"a":1}` hash identically —
 * two spellings of one request should be one request. (Contrast the webhook
 * path, which hashes the **raw bytes** precisely because the signature covers
 * the bytes and re-serialising would break it. The two hashes answer different
 * questions and are deliberately computed differently.)
 */
export function hashRequest(body: unknown): string {
  return createHash('sha256').update(canonicalise(body)).digest('hex');
}

function canonicalise(value: unknown): string {
  /**
   * **bigint first, and this cost real time to find.**
   *
   * `JSON.stringify(1n)` throws `TypeError: Do not know how to serialize a
   * BigInt`. The body reaching here has already been through Zod, and the
   * `PositiveQuantity` contract *transforms* its decimal string into a bigint —
   * so `request.body.quantity` is a bigint by the time it gets hashed, and the
   * generic `JSON.stringify` branch below threw on every order that carried an
   * `Idempotency-Key`.
   *
   * It presented as a bare 500 with `err: {}` in the log, because a separate
   * bug in the logger was discarding Error detail at the same time. Two of this
   * project's own themes — bigint serialization and observability — conspiring
   * in its own idempotency code.
   *
   * Rendered as the exact decimal digits, with no `n` suffix, so the hash is
   * stable and `1n` and `"1"` are deliberately *different* inputs: a client
   * sending a number where a string belongs is a different request, not the
   * same one.
   */
  if (typeof value === 'bigint') return `${value.toString()}n`;

  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

export interface ClaimRequest {
  route: string;
  key: string;
  requestHash: string;
  /** When true, use the deliberately racy lookup-then-insert path. */
  naive?: boolean;
  /**
   * Test seam, awaited between the naive path's read and its write.
   *
   * Exactly the same device Phase 1 uses on the naive ledger, and for the same
   * reason: it makes the race a property of the code's structure rather than of
   * scheduler luck. Without it the SELECT and INSERT are adjacent enough that
   * the duplicate reproduces only intermittently, and an intermittent
   * demonstration is not a demonstration.
   *
   * Ignored by the correct path, which has no window to widen.
   */
  barrier?: () => Promise<void>;
}

export async function claim(pool: pg.Pool, request: ClaimRequest): Promise<ClaimOutcome> {
  return request.naive ? claimNaive(pool, request) : claimAtomic(pool, request);
}

/**
 * The correct path: one statement decides who owns the key.
 */
async function claimAtomic(pool: pg.Pool, request: ClaimRequest): Promise<ClaimOutcome> {
  const inserted = await pool.query<{ id: bigint }>(
    `INSERT INTO idempotency_keys (route, key, request_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (route, key) DO NOTHING
     RETURNING id`,
    [request.route, request.key, request.requestHash],
  );

  const claimedId = inserted.rows[0]?.id;
  if (claimedId !== undefined) {
    return { status: 'claimed', id: claimedId };
  }

  // Someone else owns it. Read what they recorded.
  return inspect(pool, request);
}

/**
 * **The naive path. Deliberately wrong, and a permanent deliverable.**
 *
 * ```ts
 * const existing = await db.find(key);   // (1) nothing there
 * const order = await doTheWork();        // (2) the money moves
 * await db.insert(key, order);            // (3) too late
 * ```
 *
 * It reads, returns `claimed` to **everyone** who found no row, and does not
 * write the key until `settle` — which runs *after* the work. So two concurrent
 * retries both pass (1), both run (2), and the customer is charged twice. The
 * unique index catches the second (3), long after the money has moved: it
 * protects the bookkeeping, not the funds, and the resulting 23505 points at
 * the wrong thing entirely.
 *
 * ## A note on how this code got here
 *
 * The first version of this function did its own `INSERT` before returning
 * `claimed`. That is a *different* and accidentally-safe shape: the unique index
 * arbitrates at step (1b) and only one caller proceeds. The deterministic test
 * showed exactly one claim and the "naive" path was quietly correct — which
 * would have made this flag a prop rather than a demonstration.
 *
 * The distinction is the real lesson of this phase. "Lookup then insert" is safe
 * if the insert happens before the work and the index is allowed to decide. It
 * is unsafe when the work sits between them, which is where it naturally ends up
 * when the key is treated as a record of what happened rather than as a claim on
 * the right to do it.
 */
async function claimNaive(pool: pg.Pool, request: ClaimRequest): Promise<ClaimOutcome> {
  const existing = await pool.query<{
    state: string;
    request_hash: string;
    response_status: number | null;
    response_body: unknown;
  }>(
    `SELECT state, request_hash, response_status, response_body
       FROM idempotency_keys WHERE route = $1 AND key = $2`,
    [request.route, request.key],
  );

  const row = existing.rows[0];
  if (row) {
    if (row.state === 'completed' && row.response_status !== null) {
      return {
        status: 'replay',
        responseStatus: row.response_status,
        responseBody: row.response_body,
      };
    }
    return { status: 'in_progress' };
  }

  // THE RACE. No row exists, so this caller is told to proceed — and so is
  // every other caller that reached this point. Nothing has been written, so
  // nothing in the database knows these requests are related.
  if (request.barrier) await request.barrier();

  /**
   * `id: 0n` is a sentinel meaning "no key row exists yet". `settleNaive`
   * inserts it after the work, which is the whole defect: by then the money has
   * already moved once per caller.
   */
  return { status: 'claimed', id: NAIVE_UNCLAIMED };
}

/**
 * The sentinel id the naive path returns, because it has not written a row yet.
 *
 * `0n` is safe as a sentinel: `idempotency_keys.id` is a `GENERATED BY DEFAULT
 * AS IDENTITY` column starting at 1, so no real row can ever carry it.
 */
export const NAIVE_UNCLAIMED = 0n;

/** Read the state of a key someone else owns. */
async function inspect(pool: pg.Pool, request: ClaimRequest): Promise<ClaimOutcome> {
  const { rows } = await pool.query<{
    state: string;
    request_hash: string;
    response_status: number | null;
    response_body: unknown;
  }>(
    `SELECT state, request_hash, response_status, response_body
       FROM idempotency_keys WHERE route = $1 AND key = $2`,
    [request.route, request.key],
  );

  const row = rows[0];
  if (!row) {
    // The row vanished between the conflict and this read — only possible if the
    // reaper deleted it. Treat as in_progress: the caller retries, which is
    // correct and safe.
    return { status: 'in_progress' };
  }

  /**
   * Hash mismatch is checked **before** state, deliberately. A client reusing a
   * key with a different body has a bug, and that is true whether the first
   * request finished or not. Checking state first would replay an unrelated
   * response for the completed case and hide the bug.
   */
  if (row.request_hash !== request.requestHash) {
    return {
      status: 'mismatch',
      expectedHash: row.request_hash,
      actualHash: request.requestHash,
    };
  }

  if (row.state === 'completed' && row.response_status !== null) {
    return {
      status: 'replay',
      responseStatus: row.response_status,
      responseBody: row.response_body,
    };
  }

  if (row.state === 'failed' && row.response_status !== null) {
    // Replay the failure. Re-running a permanently-failing request on every
    // retry is how a client's retry loop becomes a denial of service.
    return {
      status: 'replay',
      responseStatus: row.response_status,
      responseBody: row.response_body,
    };
  }

  return { status: 'in_progress' };
}

/**
 * Record the outcome against a claimed key.
 *
 * `client` rather than `pool`: the settle must be able to run **inside** the
 * same transaction as the work it describes. Otherwise there is a window where
 * the order is committed and the key still says `in_progress`, and a retry
 * landing in that window gets a 409 for work that definitely succeeded.
 */
export async function settle(
  client: pg.PoolClient | pg.Pool,
  id: bigint,
  outcome: {
    state: 'completed' | 'failed';
    responseStatus: number;
    responseBody: unknown;
    orderId?: bigint;
    /** Present only on the naive path, which has no row to update yet. */
    naiveKey?: { route: string; key: string; requestHash: string };
  },
): Promise<void> {
  if (id === NAIVE_UNCLAIMED) {
    /**
     * The naive path's settle: insert the key **after** the work.
     *
     * `ON CONFLICT DO NOTHING` so the losers do not throw — the realistic naive
     * implementation would throw here and log a confusing 23505 pointing at the
     * key rather than at the duplicate order, but swallowing it makes the
     * demonstration cleaner: the duplicate orders exist and nothing complained.
     */
    if (!outcome.naiveKey) {
      throw new Error('naive settle requires the key details');
    }

    await client.query(
      `INSERT INTO idempotency_keys
         (route, key, request_hash, state, response_status, response_body, order_id, completed_at)
       VALUES ($1, $2, $3, $4::idempotency_state, $5, $6::jsonb, $7::bigint, now())
       ON CONFLICT (route, key) DO NOTHING`,
      [
        outcome.naiveKey.route,
        outcome.naiveKey.key,
        outcome.naiveKey.requestHash,
        outcome.state,
        outcome.responseStatus,
        JSON.stringify(outcome.responseBody ?? null),
        outcome.orderId?.toString() ?? null,
      ],
    );
    return;
  }

  await client.query(
    `UPDATE idempotency_keys
        SET state = $2::idempotency_state,
            response_status = $3,
            response_body = $4::jsonb,
            order_id = $5::bigint,
            completed_at = now()
      WHERE id = $1::bigint`,
    [
      id.toString(),
      outcome.state,
      outcome.responseStatus,
      JSON.stringify(outcome.responseBody ?? null),
      outcome.orderId?.toString() ?? null,
    ],
  );
}

/**
 * Delete keys older than `olderThanHours`.
 *
 * Without this the table grows forever. The retention window is "how long might
 * a client still retry" — generous, because the cost of keeping a key is one
 * row and the cost of dropping it too early is a duplicate charge.
 *
 * `in_progress` rows are deliberately included once they are old enough: a key
 * stuck in that state means the owning process died mid-request, and leaving it
 * forever means that key can never be retried at all.
 */
export async function reap(pool: pg.Pool, olderThanHours = 72): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - ($1 || ' hours')::interval`,
    [String(olderThanHours)],
  );
  return rowCount ?? 0;
}
