import { beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { parseCash, parseQuantity } from '@daftar/money';
import { useTestDatabase } from './support/test-database.ts';
import { resetLedger } from './support/reset.ts';
import {
  DEFAULT_MARKET,
  placeBookOrder,
  positionAccountExternalId,
} from '../src/exchange/engine.ts';
import { createGuest, ensureBots, findParticipant } from '../src/exchange/participants.ts';
import { positionFromTrades, readPosition } from '../src/exchange/positions.ts';
import { applyTransactional } from '../src/events/consumer.ts';
import { applyActivity } from '../src/events/consumers/activity.ts';
import { applyPosition } from '../src/events/consumers/positions.ts';
import { checkOne, startReconcileSweeps } from '../src/events/consumers/reconciler.ts';
import { decodeEnvelope, type Envelope } from '../src/events/envelope.ts';
import { toEnvelopeMessage } from '../src/outbox/relay.ts';
import { claimBatch, allShards } from '../src/outbox/worker.ts';

/**
 * The event log's PostgreSQL side. Rules under test (from the spec):
 *  - delivery is at-least-once, so a redelivered event takes effect once;
 *  - the positions projection is a pure function of the events: rebuilt from
 *    them it matches the ledger (quantity) and the trades (cost, realised P&L);
 *  - a divergence between projection and ledger is detected, with a
 *    time-to-detect measured from when it was introduced.
 *
 * Events are taken through the relay's own encoding (`toEnvelopeMessage` →
 * `decodeEnvelope`), so what is applied here is what a consumer would read.
 */

const ctx = useTestDatabase({ poolMax: 10 });
let bots: string[] = [];
let n = 0;

beforeEach(async () => {
  await resetLedger(ctx.pool);
  await ctx.pool.query('UPDATE markets SET last_price = opening_price, last_trade_at = NULL');
  bots = await ensureBots(ctx.pool, 1);
});

async function order(
  participant: string,
  side: 'buy' | 'sell',
  qty: string,
  price: string,
  type: 'limit' | 'market' = 'limit',
) {
  n += 1;
  return placeBookOrder(ctx.pool, {
    externalId: `${participant}:o-${String(n)}`,
    participantExternalId: participant,
    symbol: DEFAULT_MARKET,
    side,
    type,
    quantity: parseQuantity(qty),
    ...(type === 'limit' ? { limitPrice: parseCash(price) } : {}),
  });
}

/** Everything in the outbox, as a consumer would receive it, in relay order. */
async function relayed(): Promise<Envelope[]> {
  const out: Envelope[] = [];
  for (;;) {
    const batch = await claimBatch({
      pool: ctx.pool,
      publish: () => Promise.resolve(),
      shards: allShards(),
      workerId: 't',
      batchSize: 500,
    });
    if (batch.length === 0) break;
    for (const e of batch) out.push(decodeEnvelope(toEnvelopeMessage('t', e).value));
  }
  return out.sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
}

async function tradingGuest() {
  const created = await createGuest(ctx.pool);
  const g = (await findParticipant(ctx.pool, created.externalId))!;
  // Bot asks at three prices; the guest buys through them, sells some back
  // into a bot bid, and buys again — enough to make average cost non-trivial.
  await order(bots[0]!, 'sell', '3.00000000', '25.00');
  await order(bots[0]!, 'sell', '2.00000000', '25.37');
  await order(bots[0]!, 'sell', '50.00000000', '26.01');
  await order(g.externalId, 'buy', '4.00000000', '', 'market');
  await order(bots[0]!, 'buy', '10.00000000', '24.90');
  await order(g.externalId, 'sell', '1.33000000', '', 'market');
  await order(g.externalId, 'buy', '2.50000000', '', 'market');
  return g;
}

describe('a redelivered event takes effect once', () => {
  it('the activity feed and the positions projection each apply an event once', async () => {
    const g = await tradingGuest();
    const events = await relayed();
    expect(events.length).toBeGreaterThan(0);

    // Every event delivered three times, the copies interleaved.
    for (let round = 0; round < 3; round++) {
      for (const e of events) {
        await applyTransactional(ctx.pool, 'activity', e, applyActivity);
        if (e.type.startsWith('trade.'))
          await applyTransactional(ctx.pool, 'positions', e, applyPosition);
      }
    }

    const { rows } = await ctx.pool.query(
      'SELECT 1 FROM exchange_activity WHERE participant_id = $1::bigint',
      [g.id.toString()],
    );
    expect(rows).toHaveLength(events.length);
    const truth = await positionFromTrades(ctx.pool, g.id, DEFAULT_MARKET);
    const projected = (await readPosition(ctx.pool, g.id, DEFAULT_MARKET))!;
    expect(projected.quantity).toBe(truth.quantity);
    expect(projected.costBasis).toBe(truth.costBasis);
  });
});

describe('the positions projection is rebuildable from the events', () => {
  it('rebuilt from the events, it matches the ledger and the trades', async () => {
    const g = await tradingGuest();
    for (const e of await relayed()) {
      if (e.type.startsWith('trade.'))
        await applyTransactional(ctx.pool, 'positions', e, applyPosition);
    }
    const projected = (await readPosition(ctx.pool, g.id, DEFAULT_MARKET))!;
    const truth = await positionFromTrades(ctx.pool, g.id, DEFAULT_MARKET);
    const { rows } = await ctx.pool.query<{ balance: bigint }>(
      'SELECT balance FROM accounts WHERE external_id = $1',
      [positionAccountExternalId(g.externalId, DEFAULT_MARKET)],
    );

    expect(projected.quantity).toBe(rows[0]!.balance);
    expect(projected.costBasis).toBe(truth.costBasis);
    expect(projected.realisedPnl).toBe(truth.realisedPnl);
    expect(projected.sells).toBeGreaterThan(0);
  });

  it('dropping it and replaying gives the same figures', async () => {
    const g = await tradingGuest();
    const events = (await relayed()).filter((e) => e.type.startsWith('trade.'));
    for (const e of events) await applyTransactional(ctx.pool, 'positions', e, applyPosition);
    const before = (await readPosition(ctx.pool, g.id, DEFAULT_MARKET))!;

    await ctx.pool.query('TRUNCATE proj_positions');
    await ctx.pool.query(`DELETE FROM consumer_receipts WHERE consumer = 'positions'`);
    for (const e of events) await applyTransactional(ctx.pool, 'positions', e, applyPosition);
    const after = (await readPosition(ctx.pool, g.id, DEFAULT_MARKET))!;

    expect({ ...after, updatedAt: '' }).toEqual({ ...before, updatedAt: '' });
  });
});

describe('a divergence is detected, and timed', () => {
  it('finds an injected drift and records when it was introduced', async () => {
    const g = await tradingGuest();
    for (const e of await relayed()) {
      if (e.type.startsWith('trade.'))
        await applyTransactional(ctx.pool, 'positions', e, applyPosition);
    }

    await ctx.pool.query(
      `UPDATE proj_positions SET cost_basis = cost_basis + 7 WHERE participant_id = $1::bigint`,
      [g.id.toString()],
    );
    await ctx.pool.query(
      `INSERT INTO projection_drift_injections (participant_id, symbol, field, delta) VALUES ($1::bigint, $2, 'cost_basis', 7)`,
      [g.id.toString(), DEFAULT_MARKET],
    );
    await ctx.pool.query(
      `INSERT INTO reconcile_dirty (participant_id, symbol, event_id)
       SELECT participant_id, symbol, last_event_id FROM proj_positions`,
    );

    const sweeps = startReconcileSweeps(ctx.pool, {
      intervalMs: 20,
      log: pino({ level: 'silent' }),
    });
    let found: { kind: string; introduced_at: string | null }[] = [];
    for (let i = 0; i < 100 && found.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      found = (
        await ctx.pool.query<{ kind: string; introduced_at: string | null }>(
          'SELECT kind, introduced_at FROM reconciliation_findings',
        )
      ).rows;
    }
    await sweeps.stop();

    expect(found.map((f) => f.kind)).toContain('cost_basis_mismatch');
    expect(found.find((f) => f.kind === 'cost_basis_mismatch')!.introduced_at).not.toBeNull();
  });
});

describe('a trade the projection has not applied yet is not a divergence', () => {
  /**
   * Rule: a trade committed to the ledger whose event the projection has not
   * applied yet is not a finding — the reconciler compares the projection with
   * the ledger as of the projection's last event. And it still finds real
   * drift while such a trade is in flight.
   *
   * The guest buys once and the projection applies that event; the guest buys
   * again, and that trade's events stay in the outbox, unapplied.
   */
  async function guestWithUnappliedTrade() {
    const created = await createGuest(ctx.pool);
    const g = (await findParticipant(ctx.pool, created.externalId))!;
    await order(bots[0]!, 'sell', '3.00000000', '25.00');
    await order(bots[0]!, 'sell', '2.00000000', '25.37');
    await order(g.externalId, 'buy', '1.00000000', '', 'market');
    await applyTrades(await relayed());

    // Committed to the ledger and the trades table; its events are not relayed.
    await order(g.externalId, 'buy', '2.50000000', '', 'market');
    return g;
  }

  async function applyTrades(events: Envelope[]) {
    for (const e of events) {
      if (e.type.startsWith('trade.'))
        await applyTransactional(ctx.pool, 'positions', e, applyPosition);
    }
  }

  async function checkAsOfProjection(g: { id: bigint; externalId: string }) {
    const projected = (await readPosition(ctx.pool, g.id, DEFAULT_MARKET))!;
    return checkOne(ctx.pool, {
      participant_id: g.id,
      external_id: g.externalId,
      symbol: DEFAULT_MARKET,
      event_id: projected.lastEventId,
      marked_at: new Date().toISOString(),
    });
  }

  async function positionFindings() {
    const { rows } = await ctx.pool.query<{ kind: string }>(
      `SELECT kind FROM reconciliation_findings
        WHERE kind IN ('quantity_mismatch', 'cost_basis_mismatch', 'realised_mismatch')
        ORDER BY kind`,
    );
    return rows.map((r) => r.kind);
  }

  it('records nothing while the event is in flight, nor once it is applied', async () => {
    const g = await guestWithUnappliedTrade();

    expect((await readPosition(ctx.pool, g.id, DEFAULT_MARKET))!.quantity).toBe(
      parseQuantity('1.00000000'),
    );
    expect(await checkAsOfProjection(g)).toBe(true);
    expect(await positionFindings()).toEqual([]);

    await applyTrades(await relayed());
    expect((await readPosition(ctx.pool, g.id, DEFAULT_MARKET))!.quantity).toBe(
      parseQuantity('3.50000000'),
    );
    expect(await checkAsOfProjection(g)).toBe(true);
    expect(await positionFindings()).toEqual([]);
  });

  it('still records a projection corrupted while the event is in flight', async () => {
    const g = await guestWithUnappliedTrade();
    await ctx.pool.query(
      `UPDATE proj_positions SET quantity = quantity + 1, cost_basis = cost_basis + 7
        WHERE participant_id = $1::bigint`,
      [g.id.toString()],
    );

    expect(await checkAsOfProjection(g)).toBe(true);
    expect(await positionFindings()).toEqual(['cost_basis_mismatch', 'quantity_mismatch']);
  });
});
