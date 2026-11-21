import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { parseCash, parseQuantity } from '@daftar/money';
import { buildApp, type App } from '../src/app.ts';
import { env } from '../src/env.ts';
import { useTestDatabase } from './support/test-database.ts';
import { resetLedger } from './support/reset.ts';
import { DEFAULT_MARKET, placeBookOrder } from '../src/exchange/engine.ts';
import { FUNDING_EXTERNAL_ID, netContributed, transfer, withdraw } from '../src/exchange/cash.ts';
import {
  GUEST_STARTING_CASH,
  createGuest,
  ensureBots,
  findParticipant,
  type FoundParticipant,
} from '../src/exchange/participants.ts';
import { GUEST_COOKIE, issueGuestToken } from '../src/exchange/session.ts';
import { activityPublisher } from '../src/outbox/runner.ts';
import { allShards, drainOnce } from '../src/outbox/worker.ts';

/**
 * The exchange paths that use what only the legacy path used before:
 * `Idempotency-Key` replay, webhook-funded deposits, the outbox, and cash
 * movements that run outside the market lock.
 */

// Modest on purpose: the server's connection limit is shared with every other
// test file running in parallel, and the pool queues what does not fit.
const ctx = useTestDatabase({ poolMax: 15 });

let app: App;
let bots: string[] = [];

beforeAll(async () => {
  app = await buildApp({ pool: ctx.pool, loggerOverride: pino({ level: 'silent' }) });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetLedger(ctx.pool);
  await ctx.pool.query('UPDATE markets SET last_price = opening_price, last_trade_at = NULL');
  bots = await ensureBots(ctx.pool, 2);
});

async function guest(): Promise<FoundParticipant & { cookie: string }> {
  const created = await createGuest(ctx.pool);
  const found = (await findParticipant(ctx.pool, created.externalId))!;
  return {
    ...found,
    cookie: `${GUEST_COOKIE}=${issueGuestToken(env.GUEST_SESSION_SECRET, created.externalId)}`,
  };
}

const balanceOf = async (externalId: string): Promise<bigint> => {
  const { rows } = await ctx.pool.query<{ balance: bigint }>(
    'SELECT balance FROM accounts WHERE external_id = $1',
    [externalId],
  );
  return rows[0]!.balance;
};

/** Every unit nets to zero, and no stored balance disagrees with its entries. */
async function expectLedgerSound(): Promise<void> {
  const { rows: totals } = await ctx.pool.query<{ net_amount: bigint }>(
    'SELECT net_amount FROM ledger_totals_by_unit',
  );
  for (const row of totals) expect(row.net_amount).toBe(0n);

  const { rows: drift } = await ctx.pool.query(
    'SELECT account_id FROM account_derived_balances WHERE drift <> 0',
  );
  expect(drift).toHaveLength(0);
}

let sequence = 0;
const nextId = (): string => `test-${String((sequence += 1)).padStart(8, '0')}`;

describe('deposits through the webhook handler', () => {
  it('credits once however many times the provider delivers', async () => {
    const g = await guest();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/exchange/deposits',
      headers: { cookie: g.cookie },
      payload: { amount: '250.00', deliveries: 5 },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      credited: boolean;
      summary: { processed: number; duplicates: number; rejected: number };
      deliveries: { status: number; outcome: string }[];
    }>();

    expect(body.credited).toBe(true);
    expect(body.summary.processed).toBe(1);
    expect(body.summary.rejected).toBe(0);
    expect(body.deliveries.length).toBeGreaterThanOrEqual(5);

    expect(await balanceOf(g.externalId)).toBe(GUEST_STARTING_CASH + parseCash('250.00'));
    expect(await balanceOf(FUNDING_EXTERNAL_ID)).toBe(-parseCash('250.00'));

    const { rows } = await ctx.pool.query<{ state: string; delivery_count: number }>(
      'SELECT state, delivery_count FROM webhook_events',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('processed');
    expect(rows[0]!.delivery_count).toBeGreaterThanOrEqual(5);

    await expectLedgerSound();
  });

  it('refuses a deposit above the cap, and a request with no session', async () => {
    const g = await guest();

    const tooLarge = await app.inject({
      method: 'POST',
      url: '/v1/exchange/deposits',
      headers: { cookie: g.cookie },
      payload: { amount: '10000.01' },
    });
    expect(tooLarge.statusCode).toBe(422);

    const anonymous = await app.inject({
      method: 'POST',
      url: '/v1/exchange/deposits',
      payload: { amount: '10.00' },
    });
    expect(anonymous.statusCode).toBe(401);

    expect(await balanceOf(g.externalId)).toBe(GUEST_STARTING_CASH);
  });
});

describe('Idempotency-Key on exchange orders', () => {
  const place = (cookie: string, key: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/exchange/orders',
      headers: { cookie, 'idempotency-key': key },
      payload: body,
    });

  it('replays the original answer instead of placing a second order', async () => {
    const g = await guest();
    const body = {
      type: 'limit',
      clientOrderId: nextId(),
      side: 'buy',
      quantity: '1.00000000',
      limitPrice: '20.00',
    };

    const first = await place(g.cookie, 'key-replay-0001', body);
    const second = await place(g.cookie, 'key-replay-0001', body);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    const { rows } = await ctx.pool.query('SELECT id FROM book_orders WHERE participant_id = $1', [
      g.id.toString(),
    ]);
    expect(rows).toHaveLength(1);
  });

  it('places one order from eight simultaneous identical requests', async () => {
    const g = await guest();
    const body = {
      type: 'limit',
      clientOrderId: nextId(),
      side: 'buy',
      quantity: '1.00000000',
      limitPrice: '20.00',
    };

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => place(g.cookie, 'key-concurrent-01', body)),
    );

    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    // The rest saw the claim: a replay (200) or "still working" (409). Never a
    // second 201.
    for (const status of statuses) expect([200, 201, 409]).toContain(status);

    const { rows } = await ctx.pool.query('SELECT id FROM book_orders WHERE participant_id = $1', [
      g.id.toString(),
    ]);
    expect(rows).toHaveLength(1);
  });

  it('rejects the same key with a different request', async () => {
    const g = await guest();
    const base = { type: 'limit', side: 'buy', quantity: '1.00000000', limitPrice: '20.00' };

    const first = await place(g.cookie, 'key-mismatch-001', { ...base, clientOrderId: nextId() });
    const second = await place(g.cookie, 'key-mismatch-001', {
      ...base,
      clientOrderId: nextId(),
      quantity: '2.00000000',
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(422);
    expect(second.json<{ error: string }>().error).toBe('idempotency_key_reused');
  });

  it('replays a refusal rather than matching again', async () => {
    const g = await guest();
    // A market buy against an empty book is refused and leaves no order row.
    const body = { type: 'market', clientOrderId: nextId(), side: 'buy', quantity: '1.00000000' };

    const first = await place(g.cookie, 'key-refusal-0001', body);
    expect(first.statusCode).toBe(422);

    // Liquidity arrives. A retry of the SAME request must not now trade.
    await placeBookOrder(ctx.pool, {
      externalId: `${bots[0]!}:ask-1`,
      participantExternalId: bots[0]!,
      symbol: DEFAULT_MARKET,
      side: 'sell',
      type: 'limit',
      quantity: parseQuantity('5.00000000'),
      limitPrice: parseCash('25.00'),
    });

    const second = await place(g.cookie, 'key-refusal-0001', body);
    expect(second.statusCode).toBe(422);
    expect(second.json()).toEqual(first.json());
    expect(await balanceOf(g.externalId)).toBe(GUEST_STARTING_CASH);
  });

  it('keeps one guest’s keys separate from another’s', async () => {
    const a = await guest();
    const b = await guest();
    const body = { type: 'limit', side: 'buy', quantity: '1.00000000', limitPrice: '20.00' };

    const first = await place(a.cookie, 'key-shared-00001', { ...body, clientOrderId: nextId() });
    const second = await place(b.cookie, 'key-shared-00001', { ...body, clientOrderId: nextId() });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
  });
});

describe('withdrawals', () => {
  it('moves cash to the funding boundary in one balanced transaction', async () => {
    const g = await guest();

    const result = await withdraw(ctx.pool, {
      mover: g,
      externalId: `${g.externalId}:${nextId()}`,
      amount: parseCash('400.00'),
    });

    expect(result.status).toBe('moved');
    expect(await balanceOf(g.externalId)).toBe(GUEST_STARTING_CASH - parseCash('400.00'));
    expect(await balanceOf(FUNDING_EXTERNAL_ID)).toBe(parseCash('400.00'));
    await expectLedgerSound();
  });

  it('never overdraws under concurrent withdrawals of the whole balance', async () => {
    const g = await guest();

    // 30 withdrawals of 1,000.00 against 10,000.00: exactly 10 can succeed.
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        withdraw(ctx.pool, {
          mover: g,
          externalId: `${g.externalId}:${nextId()}`,
          amount: parseCash('1000.00'),
        }),
      ),
    );

    expect(results.filter((r) => r.status === 'moved')).toHaveLength(10);
    expect(results.filter((r) => r.status === 'insufficient_funds')).toHaveLength(20);
    expect(await balanceOf(g.externalId)).toBe(0n);
    await expectLedgerSound();
  });

  it('will not withdraw cash an open buy order has reserved', async () => {
    const g = await guest();

    // Reserves 9,000.00 of the 10,000.00.
    await placeBookOrder(ctx.pool, {
      externalId: `${g.externalId}:${nextId()}`,
      participantExternalId: g.externalId,
      symbol: DEFAULT_MARKET,
      side: 'buy',
      type: 'limit',
      quantity: parseQuantity('450.00000000'),
      limitPrice: parseCash('20.00'),
    });

    const result = await withdraw(ctx.pool, {
      mover: g,
      externalId: `${g.externalId}:${nextId()}`,
      amount: parseCash('2000.00'),
    });

    expect(result.status).toBe('insufficient_funds');
    expect(await balanceOf(g.externalId)).toBe(GUEST_STARTING_CASH);
  });

  it('turns a repeated client id into a 409, not a second withdrawal', async () => {
    const g = await guest();
    const payload = { clientId: nextId(), amount: '100.00' };
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/exchange/withdrawals',
        headers: { cookie: g.cookie },
        payload,
      });

    expect((await send()).statusCode).toBe(201);
    expect((await send()).statusCode).toBe(409);
    expect(await balanceOf(g.externalId)).toBe(GUEST_STARTING_CASH - parseCash('100.00'));
  });
});

describe('transfers between guests', () => {
  it('moves cash by handle and nets to zero', async () => {
    const a = await guest();
    const b = await guest();

    const result = await transfer(ctx.pool, {
      mover: a,
      externalId: `${a.externalId}:${nextId()}`,
      toHandle: b.handle,
      amount: parseCash('75.50'),
    });

    expect(result.status).toBe('moved');
    expect(await balanceOf(a.externalId)).toBe(GUEST_STARTING_CASH - parseCash('75.50'));
    expect(await balanceOf(b.externalId)).toBe(GUEST_STARTING_CASH + parseCash('75.50'));
    await expectLedgerSound();
  });

  it('does not deadlock when two guests pay each other at once', async () => {
    const a = await guest();
    const b = await guest();

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) => {
        const [from, to] = index % 2 === 0 ? [a, b] : [b, a];
        return transfer(ctx.pool, {
          mover: from,
          externalId: `${from.externalId}:${nextId()}`,
          toHandle: to.handle,
          amount: parseCash('10.00'),
        });
      }),
    );

    for (const result of results) {
      expect(result.status).toBe('moved');
      // Non-zero would mean the ascending lock order has a hole in it.
      if (result.status === 'moved') expect(result.deadlocks).toBe(0);
    }

    // Twenty each way: both end where they started.
    expect(await balanceOf(a.externalId)).toBe(GUEST_STARTING_CASH);
    expect(await balanceOf(b.externalId)).toBe(GUEST_STARTING_CASH);
    await expectLedgerSound();
  });

  it('refuses an unknown handle, a bot, and oneself', async () => {
    const a = await guest();
    const bot = (await findParticipant(ctx.pool, bots[0]!))!;
    const send = (toHandle: string) =>
      transfer(ctx.pool, {
        mover: a,
        externalId: `${a.externalId}:${nextId()}`,
        toHandle,
        amount: parseCash('1.00'),
      });

    expect((await send('0000000000')).status).toBe('unknown_recipient');
    expect((await send(bot.handle)).status).toBe('unknown_recipient');
    expect((await send(a.handle)).status).toBe('self_transfer');
  });
});

describe('cash movements racing the matcher', () => {
  it('a withdrawal and a fill cannot both spend the same cash', async () => {
    const g = await guest();

    await placeBookOrder(ctx.pool, {
      externalId: `${bots[0]!}:${nextId()}`,
      participantExternalId: bots[0]!,
      symbol: DEFAULT_MARKET,
      side: 'sell',
      type: 'limit',
      quantity: parseQuantity('400.00000000'),
      limitPrice: parseCash('25.00'),
    });

    // Both want the whole 10,000.00: a market buy of 400 at 25.00, and a
    // withdrawal of everything. Whatever the interleaving, the balance must
    // not go negative and the ledger must still balance.
    await Promise.all([
      placeBookOrder(ctx.pool, {
        externalId: `${g.externalId}:${nextId()}`,
        participantExternalId: g.externalId,
        symbol: DEFAULT_MARKET,
        side: 'buy',
        type: 'market',
        quantity: parseQuantity('400.00000000'),
      }),
      withdraw(ctx.pool, {
        mover: g,
        externalId: `${g.externalId}:${nextId()}`,
        amount: GUEST_STARTING_CASH,
      }),
    ]);

    expect(await balanceOf(g.externalId)).toBeGreaterThanOrEqual(0n);
    await expectLedgerSound();
  });
});

describe('the outbox on the exchange', () => {
  const worker = () => ({
    pool: ctx.pool,
    publish: activityPublisher(ctx.pool),
    shards: allShards(),
    workerId: 'test',
  });

  it('commits one event per guest side of a fill, and none for a bot', async () => {
    const g = await guest();

    await placeBookOrder(ctx.pool, {
      externalId: `${bots[0]!}:${nextId()}`,
      participantExternalId: bots[0]!,
      symbol: DEFAULT_MARKET,
      side: 'sell',
      type: 'limit',
      quantity: parseQuantity('2.00000000'),
      limitPrice: parseCash('25.00'),
    });
    await placeBookOrder(ctx.pool, {
      externalId: `${g.externalId}:${nextId()}`,
      participantExternalId: g.externalId,
      symbol: DEFAULT_MARKET,
      side: 'buy',
      type: 'market',
      quantity: parseQuantity('2.00000000'),
    });

    const { rows } = await ctx.pool.query<{ event_type: string; account_id: bigint }>(
      'SELECT event_type, account_id FROM outbox',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe('trade.buy');
    expect(rows[0]!.account_id).toBe(g.cashAccountId);
  });

  it('delivers to the feed, and a redelivery is still one row', async () => {
    const a = await guest();
    const b = await guest();

    await transfer(ctx.pool, {
      mover: a,
      externalId: `${a.externalId}:${nextId()}`,
      toHandle: b.handle,
      amount: parseCash('5.00'),
    });

    const first = await drainOnce(worker());
    expect(first.published).toBe(2);

    // At-least-once: put the rows back as if the worker died before settling.
    await ctx.pool.query(
      `UPDATE outbox SET state = 'pending', published_at = 'infinity', available_at = now()`,
    );
    const second = await drainOnce(worker());
    expect(second.published).toBe(2);

    const { rows } = await ctx.pool.query<{ event_type: string; participant_id: bigint }>(
      'SELECT event_type, participant_id FROM exchange_activity ORDER BY event_type',
    );
    expect(rows.map((r) => r.event_type)).toEqual(['transfer.received', 'transfer.sent']);
    expect(rows[0]!.participant_id).toBe(b.id);
    expect(rows[1]!.participant_id).toBe(a.id);
  });

  it('reports events as pending until the worker runs', async () => {
    const g = await guest();
    await withdraw(ctx.pool, {
      mover: g,
      externalId: `${g.externalId}:${nextId()}`,
      amount: parseCash('1.00'),
    });

    const read = async () =>
      (
        await app.inject({
          method: 'GET',
          url: '/v1/exchange/activity',
          headers: { cookie: g.cookie },
        })
      ).json<{ pending: number; events: { type: string; amount: string }[] }>();

    const before = await read();
    expect(before.pending).toBe(1);
    expect(before.events).toHaveLength(0);

    await drainOnce(worker());

    const after = await read();
    expect(after.pending).toBe(0);
    expect(after.events).toHaveLength(1);
    expect(after.events[0]!.type).toBe('withdrawal.completed');
    expect(after.events[0]!.amount).toBe('1.00');
  });
});

describe('net contributions', () => {
  it('counts the opening credit, deposits, withdrawals and transfers — not trades', async () => {
    const a = await guest();
    const b = await guest();

    await withdraw(ctx.pool, {
      mover: a,
      externalId: `${a.externalId}:${nextId()}`,
      amount: parseCash('100.00'),
    });
    await transfer(ctx.pool, {
      mover: b,
      externalId: `${b.externalId}:${nextId()}`,
      toHandle: a.handle,
      amount: parseCash('30.00'),
    });

    // A trade must not move the figure.
    await placeBookOrder(ctx.pool, {
      externalId: `${bots[0]!}:${nextId()}`,
      participantExternalId: bots[0]!,
      symbol: DEFAULT_MARKET,
      side: 'sell',
      type: 'limit',
      quantity: parseQuantity('1.00000000'),
      limitPrice: parseCash('25.00'),
    });
    await placeBookOrder(ctx.pool, {
      externalId: `${a.externalId}:${nextId()}`,
      participantExternalId: a.externalId,
      symbol: DEFAULT_MARKET,
      side: 'buy',
      type: 'market',
      quantity: parseQuantity('1.00000000'),
    });

    expect(await netContributed(ctx.pool, a.cashAccountId)).toBe(
      GUEST_STARTING_CASH - parseCash('100.00') + parseCash('30.00'),
    );
  });
});
