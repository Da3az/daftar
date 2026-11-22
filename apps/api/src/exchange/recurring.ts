import { randomUUID } from 'node:crypto';
import { notional } from '@daftar/money';
import type pg from 'pg';
import {
  claim,
  hashRequest,
  release as releaseKey,
  settle as settleKey,
} from '../idempotency/keys.ts';
import { getBook, getMarket } from './queries.ts';
import { placeBookOrder, reservationsOf } from './engine.ts';

/**
 * # Recurring buys
 *
 * A plan spends a fixed amount of cash at a fixed cadence. Each firing is a
 * **market buy through the same `placeBookOrder()` the HTTP route calls**,
 * guarded by the same idempotency-key table, keyed by
 * `<plan id>-<scheduled fire time>`.
 *
 * ## Why one firing is one order, however often it is delivered
 *
 * Three layers, the last two in PostgreSQL:
 *
 * 1. BullMQ's job id for a scheduler tick is per scheduled time.
 * 2. The idempotency key is claimed before matching and settled **inside the
 *    matching transaction**, as the order route does: a retried firing gets
 *    the recorded answer instead of trading again.
 * 3. The order's client id is derived from the same plan id and fire time, and
 *    `book_orders.external_id` is UNIQUE; the run row is UNIQUE on
 *    `(plan_id, scheduled_for)` and written in the matching transaction too.
 *
 * ## Sizing a fixed amount into a quantity
 *
 * The book is read and walked level by level, buying whole lots while the
 * running cost stays within the amount. The order then goes in as a market
 * order for that quantity. The book can move between the read and the match,
 * so the spend can differ from the amount by what moved in those milliseconds
 * — the run records what was actually paid, and the guest's own cash is the
 * hard limit (the matcher trims a buy to what the guest can afford).
 */

export const DCA_ROUTE = 'dca.fire';
const STALE_CLAIM_MS = 120_000;

export const CADENCES = {
  '1m': 60_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
  '1w': 7 * 86_400_000,
} as const;
export type Cadence = keyof typeof CADENCES;

export interface Plan {
  id: string;
  participantId: bigint;
  symbol: string;
  amount: bigint;
  everyMs: number;
  status: 'active' | 'paused' | 'deleted';
  createdAt: string;
  updatedAt: string;
}

interface PlanRow {
  id: string;
  participant_id: bigint;
  symbol: string;
  amount: bigint;
  every_ms: bigint;
  status: Plan['status'];
  created_at: string;
  updated_at: string;
}

const toPlan = (r: PlanRow): Plan => ({
  id: r.id,
  participantId: r.participant_id,
  symbol: r.symbol,
  amount: r.amount,
  everyMs: Number(r.every_ms),
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function createPlan(
  pool: pg.Pool,
  plan: { participantId: bigint; symbol: string; amount: bigint; everyMs: number },
): Promise<Plan> {
  const { rows } = await pool.query<PlanRow>(
    `INSERT INTO recurring_plans (id, participant_id, symbol, amount, every_ms)
     VALUES ($1, $2::bigint, $3, $4::bigint, $5::bigint)
     RETURNING *`,
    [
      `rp-${randomUUID()}`,
      plan.participantId.toString(),
      plan.symbol,
      plan.amount.toString(),
      String(plan.everyMs),
    ],
  );
  return toPlan(rows[0]!);
}

export async function getPlan(pool: pg.Pool, id: string): Promise<Plan | null> {
  const { rows } = await pool.query<PlanRow>('SELECT * FROM recurring_plans WHERE id = $1', [id]);
  return rows[0] ? toPlan(rows[0]) : null;
}

export async function listPlans(pool: pg.Pool, participantId: bigint): Promise<Plan[]> {
  const { rows } = await pool.query<PlanRow>(
    `SELECT * FROM recurring_plans
      WHERE participant_id = $1::bigint AND status <> 'deleted'
      ORDER BY created_at DESC LIMIT 20`,
    [participantId.toString()],
  );
  return rows.map(toPlan);
}

export async function activePlans(pool: pg.Pool): Promise<Plan[]> {
  const { rows } = await pool.query<PlanRow>(
    `SELECT * FROM recurring_plans WHERE status = 'active'`,
  );
  return rows.map(toPlan);
}

/** Scoped by participant: a guest can only change their own plans. */
export async function setPlanStatus(
  pool: pg.Pool,
  participantId: bigint,
  id: string,
  status: Plan['status'],
): Promise<Plan | null> {
  const { rows } = await pool.query<PlanRow>(
    `UPDATE recurring_plans SET status = $3, updated_at = now()
      WHERE id = $1 AND participant_id = $2::bigint AND status <> 'deleted'
      RETURNING *`,
    [id, participantId.toString(), status],
  );
  return rows[0] ? toPlan(rows[0]) : null;
}

export interface Run {
  scheduledFor: string;
  status: 'filled' | 'partial' | 'skipped';
  quantity: bigint | null;
  notional: bigint | null;
  reason: string | null;
}

export async function listRuns(
  pool: pg.Pool,
  planIds: string[],
  perPlan = 20,
): Promise<Map<string, Run[]>> {
  const out = new Map<string, Run[]>();
  if (planIds.length === 0) return out;
  const { rows } = await pool.query<{
    plan_id: string;
    scheduled_for: string;
    status: Run['status'];
    quantity: bigint | null;
    notional: bigint | null;
    reason: string | null;
  }>(
    `SELECT plan_id, scheduled_for, status, quantity, notional, reason FROM (
       SELECT r.*, row_number() OVER (PARTITION BY plan_id ORDER BY scheduled_for DESC) AS n
         FROM recurring_runs r WHERE plan_id = ANY($1::text[])
     ) x WHERE n <= $2 ORDER BY plan_id, scheduled_for DESC`,
    [planIds, perPlan],
  );
  for (const r of rows) {
    const list = out.get(r.plan_id) ?? [];
    list.push({
      scheduledFor: r.scheduled_for,
      status: r.status,
      quantity: r.quantity,
      notional: r.notional,
      reason: r.reason,
    });
    out.set(r.plan_id, list);
  }
  return out;
}

/** Average price paid across every filled run: total cash / total quantity. */
export async function averagePaid(
  pool: pg.Pool,
  planIds: string[],
): Promise<Map<string, { quantity: bigint; notional: bigint }>> {
  const out = new Map<string, { quantity: bigint; notional: bigint }>();
  if (planIds.length === 0) return out;
  const { rows } = await pool.query<{ plan_id: string; quantity: bigint; notional: bigint }>(
    `SELECT plan_id, coalesce(sum(quantity), 0)::bigint AS quantity,
            coalesce(sum(notional), 0)::bigint AS notional
       FROM recurring_runs WHERE plan_id = ANY($1::text[]) AND status IN ('filled', 'partial')
      GROUP BY plan_id`,
    [planIds],
  );
  for (const r of rows) out.set(r.plan_id, { quantity: r.quantity, notional: r.notional });
  return out;
}

/** Whole lots that `amount` buys walking up the asks, best price first. */
export function sizeAgainstBook(
  asks: { price: bigint; quantity: bigint }[],
  amount: bigint,
  lotSize: bigint,
): { quantity: bigint; cost: bigint } {
  let quantity = 0n;
  let cost = 0n;
  for (const level of asks) {
    const left = amount - cost;
    const atLevel = level.quantity - (level.quantity % lotSize);
    // The most whole lots `left` pays for at this price, stepping down while
    // the half-up-rounded notional still exceeds it.
    let affordable = (left * 100_000_000n) / level.price;
    affordable -= affordable % lotSize;
    while (affordable > 0n && notional(affordable, level.price) > left) affordable -= lotSize;

    const take = atLevel < affordable ? atLevel : affordable;
    if (take <= 0n) break;
    quantity += take;
    cost += notional(take, level.price);
    // Stopped short of this level's size: the money ran out here.
    if (take < atLevel) break;
  }
  return { quantity, cost };
}

export type FireOutcome =
  | { status: 'filled' | 'partial'; quantity: bigint; notional: bigint }
  | { status: 'skipped'; reason: string }
  | { status: 'noop' }
  | { status: 'retry_later' };

async function recordSkip(
  pool: pg.Pool,
  plan: Plan,
  scheduledFor: Date,
  reason: string,
): Promise<{ runId: bigint } | null> {
  const { rows } = await pool.query<{ id: bigint }>(
    `INSERT INTO recurring_runs (plan_id, scheduled_for, status, reason)
     VALUES ($1, $2::timestamptz, 'skipped', $3)
     ON CONFLICT (plan_id, scheduled_for) DO NOTHING
     RETURNING id`,
    [plan.id, scheduledFor.toISOString(), reason],
  );
  if (!rows[0]) return null;

  // The notification is written with the run, keyed on the run's id, so a
  // retried firing cannot notify twice.
  await pool.query(
    `INSERT INTO notifications (participant_id, event_id, kind, title, body, occurred_at)
     VALUES ($1::bigint, $2::bigint, 'dca.skipped', 'A recurring buy was skipped', $3, $4::timestamptz)
     ON CONFLICT (event_id, kind) DO NOTHING`,
    [plan.participantId.toString(), rows[0].id.toString(), reason, scheduledFor.toISOString()],
  );
  return { runId: rows[0].id };
}

/**
 * Fire one scheduled run of a plan. Safe to call any number of times for the
 * same `(plan, scheduledFor)`.
 */
export async function firePlan(
  pool: pg.Pool,
  planId: string,
  scheduledFor: Date,
): Promise<FireOutcome> {
  const plan = await getPlan(pool, planId);
  if (!plan || plan.status !== 'active') return { status: 'noop' };

  const { rows: existing } = await pool.query(
    'SELECT 1 FROM recurring_runs WHERE plan_id = $1 AND scheduled_for = $2::timestamptz',
    [plan.id, scheduledFor.toISOString()],
  );
  if (existing.length > 0) return { status: 'noop' };

  const { rows: who } = await pool.query<{ external_id: string; cash_account_id: bigint }>(
    'SELECT external_id, cash_account_id FROM participants WHERE id = $1::bigint',
    [plan.participantId.toString()],
  );
  const participant = who[0];
  if (!participant) return { status: 'noop' };

  const fireMs = scheduledFor.getTime();
  const clientOrderId = `${plan.id}-${String(fireMs)}`;
  const orderExternalId = `${participant.external_id}:${clientOrderId}`;
  const key = `${participant.external_id}:${plan.id}-${String(fireMs)}`;

  const outcome = await claim(pool, {
    route: DCA_ROUTE,
    key,
    requestHash: hashRequest({ planId: plan.id, scheduledFor: fireMs }),
  });

  if (outcome.status === 'replay') return { status: 'noop' };
  if (outcome.status === 'mismatch') return { status: 'noop' };
  if (outcome.status === 'in_progress') {
    // Either another worker is firing this right now, or a worker died after
    // claiming and before matching. In the second case the key would block
    // this run until the reaper; so a claim older than STALE_CLAIM_MS with no
    // order behind it is released and the job retried.
    const { rows: stale } = await pool.query<{ id: bigint }>(
      `SELECT k.id FROM idempotency_keys k
        WHERE k.route = $1 AND k.key = $2 AND k.state = 'in_progress'
          AND k.created_at < now() - ($3 || ' milliseconds')::interval
          AND NOT EXISTS (SELECT 1 FROM book_orders o WHERE o.external_id = $4)`,
      [DCA_ROUTE, key, String(STALE_CLAIM_MS), orderExternalId],
    );
    if (stale[0]) await releaseKey(pool, stale[0].id);
    return { status: 'retry_later' };
  }

  const keyId = outcome.id;
  try {
    const market = await getMarket(pool, plan.symbol);
    if (!market) {
      await recordSkip(pool, plan, scheduledFor, 'market is not listed');
      await settleKey(pool, keyId, {
        state: 'completed',
        responseStatus: 422,
        responseBody: { skipped: 'unknown_market' },
      });
      return { status: 'skipped', reason: 'market is not listed' };
    }

    const book = await getBook(pool, plan.symbol, 50);
    const sized = sizeAgainstBook(book.asks, plan.amount, market.lotSize);

    // Insufficient cash is decided against what is spendable now. The matcher
    // re-checks under its lock; this check only makes the skip explicit.
    const { rows: bal } = await pool.query<{ balance: bigint }>(
      'SELECT balance FROM accounts WHERE id = $1::bigint',
      [participant.cash_account_id.toString()],
    );
    const reserved = await reservationsOf(pool, plan.participantId, plan.symbol);
    const available = (bal[0]?.balance ?? 0n) - reserved.cash;

    let skip: string | null = null;
    if (book.asks.length === 0) skip = 'nothing for sale on the book';
    else if (sized.quantity === 0n) skip = 'the amount buys less than one lot at the current price';
    else if (available < sized.cost) skip = 'not enough available cash';

    if (skip) {
      await recordSkip(pool, plan, scheduledFor, skip);
      await settleKey(pool, keyId, {
        state: 'completed',
        responseStatus: 422,
        responseBody: { skipped: skip },
      });
      return { status: 'skipped', reason: skip };
    }

    const result = await placeBookOrder(pool, {
      externalId: orderExternalId,
      participantExternalId: participant.external_id,
      symbol: plan.symbol,
      side: 'buy',
      type: 'market',
      quantity: sized.quantity,
      onAccepted: async (client, accepted) => {
        const filled = accepted.fills.reduce((a, f) => a + f.quantity, 0n);
        const paid = accepted.fills.reduce((a, f) => a + f.notional, 0n);
        await client.query(
          `INSERT INTO recurring_runs
             (plan_id, scheduled_for, status, order_external_id, quantity, notional)
           VALUES ($1, $2::timestamptz, $3, $4, $5::bigint, $6::bigint)`,
          [
            plan.id,
            scheduledFor.toISOString(),
            filled >= sized.quantity ? 'filled' : 'partial',
            orderExternalId,
            filled.toString(),
            paid.toString(),
          ],
        );
        await settleKey(client, keyId, {
          state: 'completed',
          responseStatus: 201,
          responseBody: { quantity: filled.toString(), notional: paid.toString() },
        });
      },
    });

    if (result.status === 'accepted') {
      const filled = result.fills.reduce((a, f) => a + f.quantity, 0n);
      const paid = result.fills.reduce((a, f) => a + f.notional, 0n);
      return {
        status: filled >= sized.quantity ? 'filled' : 'partial',
        quantity: filled,
        notional: paid,
      };
    }

    const reason =
      result.status === 'insufficient_funds'
        ? 'not enough available cash'
        : result.status === 'no_liquidity'
          ? 'nothing for sale on the book'
          : result.status === 'too_many_open_orders'
            ? 'too many open orders'
            : `order refused (${result.status})`;
    await recordSkip(pool, plan, scheduledFor, reason);
    await settleKey(pool, keyId, {
      state: 'completed',
      responseStatus: 422,
      responseBody: { skipped: reason },
    });
    return { status: 'skipped', reason };
  } catch (err) {
    // Threw rather than answered: give the key back so the retry starts clean.
    await releaseKey(pool, keyId).catch(() => undefined);
    throw err;
  }
}
