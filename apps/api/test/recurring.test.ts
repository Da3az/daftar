import { beforeEach, describe, expect, it } from 'vitest';
import { notional, parseCash, parseQuantity } from '@daftar/money';
import { useTestDatabase } from './support/test-database.ts';
import { resetLedger } from './support/reset.ts';
import { DEFAULT_MARKET, placeBookOrder } from '../src/exchange/engine.ts';
import { createGuest, ensureBots, findParticipant } from '../src/exchange/participants.ts';
import { createPlan, firePlan, setPlanStatus, sizeAgainstBook } from '../src/exchange/recurring.ts';

/**
 * Recurring buys. Rules under test (from the spec):
 *  - one scheduled run is one order, however many times it is delivered;
 *  - a run that cannot be paid for is skipped, recorded, and notified once;
 *  - a run never spends more than the plan's amount at the prices it saw;
 *  - a paused plan does not buy.
 */

const ctx = useTestDatabase({ poolMax: 10 });
let bots: string[] = [];

beforeEach(async () => {
  await resetLedger(ctx.pool);
  await ctx.pool.query('DELETE FROM recurring_runs');
  await ctx.pool.query('UPDATE markets SET last_price = opening_price, last_trade_at = NULL');
  bots = await ensureBots(ctx.pool, 1);
});

async function ask(price: string, qty: string, n: number) {
  await placeBookOrder(ctx.pool, {
    externalId: `${bots[0]!}:ask-${String(n)}`,
    participantExternalId: bots[0]!,
    symbol: DEFAULT_MARKET,
    side: 'sell',
    type: 'limit',
    quantity: parseQuantity(qty),
    limitPrice: parseCash(price),
  });
}

async function guestWithPlan(amount: string) {
  const created = await createGuest(ctx.pool);
  const g = (await findParticipant(ctx.pool, created.externalId))!;
  const plan = await createPlan(ctx.pool, {
    participantId: g.id,
    symbol: DEFAULT_MARKET,
    amount: parseCash(amount),
    everyMs: 60_000,
  });
  return { g, plan };
}

const ordersOf = async (participantId: bigint) =>
  (
    await ctx.pool.query('SELECT id FROM book_orders WHERE participant_id = $1::bigint', [
      participantId.toString(),
    ])
  ).rows.length;

describe('one scheduled run is one order', () => {
  it('firing the same tick five times at once places one order and records one run', async () => {
    await ask('25.00', '100.00000000', 1);
    const { g, plan } = await guestWithPlan('100.00');
    const tick = new Date('2026-11-22T09:00:00.000Z');

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => firePlan(ctx.pool, plan.id, tick)),
    );
    expect(outcomes.filter((o) => o.status === 'filled' || o.status === 'partial')).toHaveLength(1);

    // A late retry of the same tick is still a no-op.
    expect((await firePlan(ctx.pool, plan.id, tick)).status).toBe('noop');
    expect(await ordersOf(g.id)).toBe(1);
    const { rows } = await ctx.pool.query('SELECT 1 FROM recurring_runs WHERE plan_id = $1', [
      plan.id,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('two different ticks are two orders', async () => {
    await ask('25.00', '100.00000000', 1);
    const { g, plan } = await guestWithPlan('100.00');
    await firePlan(ctx.pool, plan.id, new Date('2026-11-22T09:00:00.000Z'));
    await firePlan(ctx.pool, plan.id, new Date('2026-11-22T09:01:00.000Z'));
    expect(await ordersOf(g.id)).toBe(2);
  });
});

describe('a run that cannot be paid for', () => {
  it('is skipped, recorded once, and notified once, however often it fires', async () => {
    // 1,000 coins at 25.00 on the book, so 20,000.00 buys 800 of them — and the
    // guest has a 10,000.00 opening balance.
    await ask('25.00', '1000.00000000', 1);
    const { g, plan } = await guestWithPlan('20000.00');
    const tick = new Date('2026-11-22T09:00:00.000Z');

    const first = await firePlan(ctx.pool, plan.id, tick);
    expect(first.status).toBe('skipped');
    await firePlan(ctx.pool, plan.id, tick);

    const runs = await ctx.pool.query<{ status: string }>(
      'SELECT status FROM recurring_runs WHERE plan_id = $1',
      [plan.id],
    );
    expect(runs.rows.map((r) => r.status)).toEqual(['skipped']);
    const notes = await ctx.pool.query(
      `SELECT 1 FROM notifications WHERE participant_id = $1::bigint AND kind = 'dca.skipped'`,
      [g.id.toString()],
    );
    expect(notes.rows).toHaveLength(1);
    expect(await ordersOf(g.id)).toBe(0);
  });

  it('is skipped when there is nothing to buy', async () => {
    const { plan } = await guestWithPlan('100.00');
    const outcome = await firePlan(ctx.pool, plan.id, new Date('2026-11-22T09:00:00.000Z'));
    expect(outcome).toMatchObject({ status: 'skipped' });
  });
});

describe('a paused plan', () => {
  it('does not buy', async () => {
    await ask('25.00', '100.00000000', 1);
    const { g, plan } = await guestWithPlan('100.00');
    await setPlanStatus(ctx.pool, g.id, plan.id, 'paused');
    expect((await firePlan(ctx.pool, plan.id, new Date())).status).toBe('noop');
    expect(await ordersOf(g.id)).toBe(0);
  });
});

describe('sizing a fixed amount against the book', () => {
  it('never costs more than the amount, and buys whole lots', () => {
    const lot = parseQuantity('0.01000000');
    const asks = [
      { price: parseCash('25.00'), quantity: parseQuantity('1.00000000') },
      { price: parseCash('25.37'), quantity: parseQuantity('2.50000000') },
      { price: parseCash('26.11'), quantity: parseQuantity('100.00000000') },
    ];
    for (const amount of ['0.24', '0.25', '24.99', '25.00', '50.00', '88.88', '1000.00']) {
      const cents = parseCash(amount);
      const { quantity, cost } = sizeAgainstBook(asks, cents, lot);
      expect(cost).toBeLessThanOrEqual(cents);
      expect(quantity % lot).toBe(0n);

      // And it is the most that fits: one more lot at the price it stopped at
      // would cost more than what is left.
      let walked = 0n;
      let stopPrice = asks[0]!.price;
      for (const level of asks) {
        stopPrice = level.price;
        if (walked + level.quantity > quantity) break;
        walked += level.quantity;
      }
      expect(cost + notional(lot, stopPrice)).toBeGreaterThan(cents);
    }
  });
});
