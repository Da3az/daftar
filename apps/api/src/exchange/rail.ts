import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';

/**
 * # The simulated payout rail
 *
 * Stands in for a bank's payout API, with the failure modes that make a
 * payout saga necessary in the first place. The saga calls it only through
 * `submit` and `status`, the two calls a real provider would offer, and treats
 * every answer as untrusted.
 *
 * ## The chaos knobs (one row in `sim_rail_config`)
 *
 * - **timeout but succeeded** — the payment is recorded, then the caller gets
 *   a timeout. The caller cannot tell this from a drop; only `status` can.
 * - **drop** — nothing is recorded, the caller gets a timeout.
 * - **reject** — recorded as rejected; the caller is told so.
 * - **latency** — every call waits this long first.
 *
 * Accepted payments stay `pending` for `confirm_after_ms`, then confirm.
 *
 * ## Idempotent by reference
 *
 * `submit` with a reference the rail already holds returns that payment's
 * status instead of creating a second one. That is what lets the saga retry a
 * timed-out submission at all.
 */

export type SubmitOutcome = 'accepted' | 'rejected';
export type RailStatus = 'not_found' | 'pending' | 'confirmed' | 'rejected';

export class RailTimeoutError extends Error {
  override name = 'RailTimeoutError';
}

interface RailConfig {
  timeout_but_succeeded_pct: number;
  drop_pct: number;
  reject_pct: number;
  latency_ms: number;
  confirm_after_ms: number;
}

async function config(pool: pg.Pool): Promise<RailConfig> {
  const { rows } = await pool.query<RailConfig>(
    `SELECT timeout_but_succeeded_pct, drop_pct, reject_pct, latency_ms, confirm_after_ms
       FROM sim_rail_config`,
  );
  return (
    rows[0] ?? {
      timeout_but_succeeded_pct: 0,
      drop_pct: 0,
      reject_pct: 0,
      latency_ms: 0,
      confirm_after_ms: 5000,
    }
  );
}

export async function submitPayment(
  pool: pg.Pool,
  payment: { reference: string; amount: bigint },
  random: () => number = Math.random,
): Promise<SubmitOutcome> {
  const c = await config(pool);
  if (c.latency_ms > 0) await sleep(c.latency_ms);

  // Seen before: answer with what was decided, never decide twice.
  const { rows: existing } = await pool.query<{ status: string }>(
    'SELECT status FROM sim_rail_payments WHERE reference = $1',
    [payment.reference],
  );
  if (existing[0]) return existing[0].status === 'rejected' ? 'rejected' : 'accepted';

  const roll = random() * 100;
  if (roll < c.drop_pct) throw new RailTimeoutError('rail did not answer (dropped)');

  const rejected = roll < c.drop_pct + c.reject_pct;
  await pool.query(
    `INSERT INTO sim_rail_payments (reference, amount, status, confirm_at, decided_at)
     VALUES ($1, $2::bigint, $3,
             CASE WHEN $3 = 'pending' THEN now() + ($4 || ' milliseconds')::interval END,
             CASE WHEN $3 = 'rejected' THEN now() END)
     ON CONFLICT (reference) DO NOTHING`,
    [
      payment.reference,
      payment.amount.toString(),
      rejected ? 'rejected' : 'pending',
      String(c.confirm_after_ms),
    ],
  );

  if (roll < c.drop_pct + c.reject_pct + c.timeout_but_succeeded_pct && !rejected) {
    throw new RailTimeoutError('rail did not answer (but recorded the payment)');
  }
  return rejected ? 'rejected' : 'accepted';
}

export async function paymentStatus(pool: pg.Pool, reference: string): Promise<RailStatus> {
  const c = await config(pool);
  if (c.latency_ms > 0) await sleep(c.latency_ms);

  // Lazily confirm anything whose pending period has passed.
  const { rows } = await pool.query<{ status: string }>(
    `UPDATE sim_rail_payments
        SET status = CASE WHEN status = 'pending' AND confirm_at <= now() THEN 'confirmed' ELSE status END,
            decided_at = CASE WHEN status = 'pending' AND confirm_at <= now() THEN now() ELSE decided_at END
      WHERE reference = $1
      RETURNING status`,
    [reference],
  );
  const status = rows[0]?.status;
  if (status === undefined) return 'not_found';
  if (status === 'confirmed' || status === 'rejected' || status === 'pending') return status;
  return 'pending';
}

export interface RailChaos {
  timeoutButSucceededPct: number;
  dropPct: number;
  rejectPct: number;
  latencyMs: number;
  confirmAfterMs: number;
}

export async function setRailChaos(pool: pg.Pool, chaos: RailChaos): Promise<void> {
  await pool.query(
    `UPDATE sim_rail_config
        SET timeout_but_succeeded_pct = $1, drop_pct = $2, reject_pct = $3,
            latency_ms = $4, confirm_after_ms = $5, updated_at = now()`,
    [
      chaos.timeoutButSucceededPct,
      chaos.dropPct,
      chaos.rejectPct,
      chaos.latencyMs,
      chaos.confirmAfterMs,
    ],
  );
}

export async function getRailChaos(pool: pg.Pool): Promise<RailChaos> {
  const c = await config(pool);
  return {
    timeoutButSucceededPct: c.timeout_but_succeeded_pct,
    dropPct: c.drop_pct,
    rejectPct: c.reject_pct,
    latencyMs: c.latency_ms,
    confirmAfterMs: c.confirm_after_ms,
  };
}
