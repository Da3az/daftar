import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { parseCash, parseQuantity } from '@daftar/money';
import { buildApp, type App } from '../src/app.ts';
import { env } from '../src/env.ts';
import { useTestDatabase } from './support/test-database.ts';
import { resetLedger } from './support/reset.ts';
import { DEFAULT_MARKET, placeBookOrder } from '../src/exchange/engine.ts';
import { FUNDING_EXTERNAL_ID, contributionsOf, transfer, withdraw } from '../src/exchange/cash.ts';
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

  it('replays a repeated client id instead of making a second withdrawal', async () => {
    const g = await guest();
    const clientId = nextId();
    const send = (amount: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/exchange/withdrawals',
        headers: { cookie: g.cookie },
        payload: { clientId, amount },
      });

    expect((await send('100.00')).statusCode).toBe(201);
    expect((await send('100.00')).statusCode).toBe(200);
    // The same id for a different movement is a conflict, not a replay.
    const different = await send('101.00');
    expect(different.statusCode).toBe(409);
    expect(different.json<{ error: string }>().error).toBe('duplicate_movement');
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

    const parts = await contributionsOf(ctx.pool, a.cashAccountId);
    expect(parts).toEqual({
      openingCredit: GUEST_STARTING_CASH,
      deposits: 0n,
      transfersIn: parseCash('30.00'),
      withdrawals: parseCash('100.00'),
      transfersOut: 0n,
      net: GUEST_STARTING_CASH - parseCash('100.00') + parseCash('30.00'),
    });
  });
});

/*
 * The fields the redesigned screens read: movement receipts, the recipient
 * lookup, rate-limit timing, deposit balance and timing, fill counterparties,
 * the contribution breakdown, and the ledger lines behind each feed row.
 */
describe('the receipt contract', () => {
  const worker = () => ({
    pool: ctx.pool,
    publish: activityPublisher(ctx.pool),
    shards: allShards(),
    workerId: 'test',
  });

  const nameOf = async (externalId: string): Promise<string> => {
    const { rows } = await ctx.pool.query<{ display_name: string }>(
      'SELECT display_name FROM participants WHERE external_id = $1',
      [externalId],
    );
    return rows[0]!.display_name;
  };

  it('answers a retried withdrawal with the original result, even when the cash is gone', async () => {
    const g = await guest();
    const clientId = nextId();
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/exchange/withdrawals',
        headers: { cookie: g.cookie },
        payload: { clientId, amount: '10000.00' },
      });

    const first = await send();
    expect(first.statusCode).toBe(201);
    const original = first.json<{ clientId: string; occurredAt: string; cashBalance: string }>();
    expect(original.clientId).toBe(clientId);
    expect(original.cashBalance).toBe('0.00');
    expect(Number.isNaN(Date.parse(original.occurredAt))).toBe(false);

    // Re-checked against today's balance, this would be insufficient_funds.
    const retry = await send();
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(original);
    expect(await balanceOf(g.externalId)).toBe(0n);
  });

  it('echoes the client id on a transfer and refuses its reuse for another recipient', async () => {
    const a = await guest();
    const b = await guest();
    const c = await guest();
    const clientId = nextId();
    const send = (toHandle: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/exchange/transfers',
        headers: { cookie: a.cookie },
        payload: { clientId, amount: '5.00', toHandle },
      });

    const first = await send(b.handle);
    expect(first.statusCode).toBe(201);
    expect(first.json<{ clientId: string }>().clientId).toBe(clientId);
    expect((await send(b.handle)).statusCode).toBe(200);
    expect((await send(c.handle)).statusCode).toBe(409);
    expect(await balanceOf(c.externalId)).toBe(GUEST_STARTING_CASH);
  });

  it('looks up a guest by handle, and only a guest', async () => {
    const a = await guest();
    const b = await guest();
    const { rows } = await ctx.pool.query<{ handle: string }>(
      'SELECT handle FROM participants WHERE external_id = $1',
      [bots[0]!],
    );
    const look = (handle: string, cookie: string | null = a.cookie) =>
      app.inject({
        method: 'GET',
        url: `/v1/exchange/recipients/${handle}`,
        headers: cookie === null ? {} : { cookie },
      });

    const found = await look(b.handle);
    expect(found.statusCode).toBe(200);
    // Nothing beyond what a transfer would reveal.
    expect(found.json()).toEqual({ handle: b.handle, displayName: b.displayName });

    expect((await look(rows[0]!.handle)).statusCode).toBe(404);
    expect((await look(a.handle)).json<{ error: string }>().error).toBe('self_transfer');
    expect((await look('NOT-A-HANDLE')).statusCode).toBe(400);
    expect((await look(b.handle, null)).statusCode).toBe(401);
  });

  it('says when a rate limit frees, in the body and the header', async () => {
    const a = await guest();
    const b = await guest();

    let limited: Awaited<ReturnType<typeof app.inject>> | null = null;
    for (let i = 0; i < 40 && limited === null; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/exchange/recipients/${b.handle}`,
        headers: { cookie: a.cookie },
      });
      if (response.statusCode === 429) limited = response;
    }

    expect(limited).not.toBeNull();
    const body = limited!.json<{ error: string; retryAfterSeconds: number }>();
    expect(body.error).toBe('rate_limited');
    expect(body.retryAfterSeconds).toBe(Number(limited!.headers['retry-after']));
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('times a deposit refused by the hourly limit', async () => {
    const g = await guest();
    await ctx.pool.query(
      `INSERT INTO deposits (participant_id, external_id, event_id, amount, deliveries)
       SELECT $1::bigint, 'dep_t' || n, 'evt_t' || n, 100, 1 FROM generate_series(1, 10) n`,
      [g.id.toString()],
    );

    const refused = await app.inject({
      method: 'POST',
      url: '/v1/exchange/deposits',
      headers: { cookie: g.cookie },
      payload: { amount: '1.00' },
    });

    expect(refused.statusCode).toBe(429);
    const body = refused.json<{ error: string; retryAfterSeconds: number }>();
    expect(body.error).toBe('deposit_limit');
    expect(body.retryAfterSeconds).toBeGreaterThan(3500);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(Number(refused.headers['retry-after'])).toBe(body.retryAfterSeconds);
  });

  it('reports the cash a deposit left and how long each delivery took', async () => {
    const g = await guest();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/exchange/deposits',
      headers: { cookie: g.cookie },
      payload: { amount: '250.00', deliveries: 3 },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ cashBalance: string; deliveries: { latencyMs: number }[] }>();
    expect(body.cashBalance).toBe('10250.00');
    for (const d of body.deliveries) {
      expect(Number.isInteger(d.latencyMs)).toBe(true);
      expect(d.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('names the other side of each fill, bot or guest', async () => {
    const a = await guest();
    const b = await guest();

    await placeBookOrder(ctx.pool, {
      externalId: `${bots[0]!}:${nextId()}`,
      participantExternalId: bots[0]!,
      symbol: DEFAULT_MARKET,
      side: 'sell',
      type: 'limit',
      quantity: parseQuantity('2.00000000'),
      limitPrice: parseCash('25.00'),
    });
    // b needs a coin before it can offer one.
    await placeBookOrder(ctx.pool, {
      externalId: `${b.externalId}:${nextId()}`,
      participantExternalId: b.externalId,
      symbol: DEFAULT_MARKET,
      side: 'buy',
      type: 'market',
      quantity: parseQuantity('1.00000000'),
    });
    await placeBookOrder(ctx.pool, {
      externalId: `${b.externalId}:${nextId()}`,
      participantExternalId: b.externalId,
      symbol: DEFAULT_MARKET,
      side: 'sell',
      type: 'limit',
      quantity: parseQuantity('1.00000000'),
      limitPrice: parseCash('25.01'),
    });
    await placeBookOrder(ctx.pool, {
      externalId: `${a.externalId}:${nextId()}`,
      participantExternalId: a.externalId,
      symbol: DEFAULT_MARKET,
      side: 'buy',
      type: 'market',
      quantity: parseQuantity('2.00000000'),
    });

    const fills = (
      await app.inject({ method: 'GET', url: '/v1/exchange/fills', headers: { cookie: a.cookie } })
    ).json<{ fills: { price: string; counterparty: string | null }[] }>().fills;

    const bot = await nameOf(bots[0]!);
    expect(fills.map((f) => [f.price, f.counterparty]).sort()).toEqual([
      ['25.00', bot],
      ['25.01', b.displayName],
    ]);

    // The maker sees the taker; and b's own earlier buy names the bot.
    const theirs = (
      await app.inject({ method: 'GET', url: '/v1/exchange/fills', headers: { cookie: b.cookie } })
    ).json<{ fills: { counterparty: string | null }[] }>().fills;
    expect(theirs.map((f) => f.counterparty)).toEqual([a.displayName, bot]);
  });

  it('names guests without any bits of the session id', async () => {
    const g = await guest();
    expect(g.displayName).toMatch(/^Guest [0-9A-F]{4}$/);
    expect(g.externalId).toMatch(/^guest-[0-9a-f]{16}$/);
  });

  it('breaks netContributed into parts that add up, on /me', async () => {
    const a = await guest();
    const b = await guest();
    const post = (url: string, cookie: string, payload: object) =>
      app.inject({ method: 'POST', url, headers: { cookie }, payload });

    await post('/v1/exchange/deposits', a.cookie, { amount: '250.00' });
    await post('/v1/exchange/withdrawals', a.cookie, { clientId: nextId(), amount: '100.00' });
    await post('/v1/exchange/transfers', b.cookie, {
      clientId: nextId(),
      amount: '30.00',
      toHandle: a.handle,
    });
    await post('/v1/exchange/transfers', a.cookie, {
      clientId: nextId(),
      amount: '20.00',
      toHandle: b.handle,
    });

    const me = (
      await app.inject({ method: 'GET', url: '/v1/exchange/me', headers: { cookie: a.cookie } })
    ).json<{ netContributed: string; contributions: Record<string, string> }>();

    expect(me.contributions).toEqual({
      openingCredit: '10000.00',
      deposits: '250.00',
      transfersIn: '30.00',
      withdrawals: '100.00',
      transfersOut: '20.00',
    });
    expect(me.netContributed).toBe('10160.00');
  });

  it('returns balanced ledger lines and the right reference for every event type', async () => {
    const a = await guest();
    const b = await guest();
    const orderId = nextId();
    const withdrawalId = nextId();
    const transferId = nextId();
    const post = (url: string, cookie: string, payload: object, headers = {}) =>
      app.inject({ method: 'POST', url, headers: { cookie, ...headers }, payload });

    await placeBookOrder(ctx.pool, {
      externalId: `${bots[0]!}:${nextId()}`,
      participantExternalId: bots[0]!,
      symbol: DEFAULT_MARKET,
      side: 'sell',
      type: 'limit',
      quantity: parseQuantity('2.00000000'),
      limitPrice: parseCash('25.00'),
    });
    expect(
      (
        await post(
          '/v1/exchange/orders',
          a.cookie,
          { clientOrderId: orderId, type: 'market', side: 'buy', quantity: '2.00000000' },
          { 'idempotency-key': orderId },
        )
      ).statusCode,
    ).toBe(201);
    const deposit = (await post('/v1/exchange/deposits', a.cookie, { amount: '40.00' })).json<{
      depositId: string;
    }>();
    await post('/v1/exchange/withdrawals', a.cookie, { clientId: withdrawalId, amount: '7.00' });
    await post('/v1/exchange/transfers', a.cookie, {
      clientId: transferId,
      amount: '3.00',
      toHandle: b.handle,
    });

    await drainOnce(worker());

    type Event = {
      type: string;
      reference: string | null;
      counterparty: string | null;
      entries: { account: string; direction: string; amount: string; unit: string }[];
    };
    const feed = async (cookie: string) =>
      (
        await app.inject({ method: 'GET', url: '/v1/exchange/activity', headers: { cookie } })
      ).json<{ events: Event[] }>().events;

    const mine = await feed(a.cookie);
    const byType = new Map(mine.map((e) => [e.type, e]));

    expect(byType.get('trade.buy')!.reference).toBe(orderId);
    expect(byType.get('trade.buy')!.counterparty).toBe(await nameOf(bots[0]!));
    expect(byType.get('deposit.credited')!.reference).toBe(deposit.depositId);
    expect(byType.get('withdrawal.completed')!.reference).toBe(withdrawalId);
    expect(byType.get('transfer.sent')!.reference).toBe(transferId);

    // A buy takes cash out of the buyer's account: a debit, as the screen says.
    expect(byType.get('trade.buy')!.entries).toContainEqual({
      account: 'Your cash',
      direction: 'debit',
      amount: '50.00',
      unit: 'USD',
    });
    expect(byType.get('trade.buy')!.entries).toContainEqual({
      account: 'Your DFT',
      direction: 'credit',
      amount: '2.00000000',
      unit: 'DFT',
    });
    expect(byType.get('deposit.credited')!.entries).toContainEqual({
      account: 'Payment provider · clearing',
      direction: 'debit',
      amount: '40.00',
      unit: 'USD',
    });
    expect(byType.get('withdrawal.completed')!.entries).toContainEqual({
      account: 'Outside world',
      direction: 'credit',
      amount: '7.00',
      unit: 'USD',
    });

    const theirs = await feed(b.cookie);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.type).toBe('transfer.received');
    // The sender's id embeds the sender's session subject; never the recipient's to see.
    expect(theirs[0]!.reference).toBeNull();
    expect(theirs[0]!.entries).toContainEqual({
      account: `${a.displayName} · cash`,
      direction: 'debit',
      amount: '3.00',
      unit: 'USD',
    });

    for (const event of [...mine, ...theirs]) {
      expect(event.entries.length).toBeGreaterThan(0);
      const net = new Map<string, bigint>();
      for (const line of event.entries) {
        // No account id, house shard name or session subject in any label.
        expect(line.account).not.toMatch(/guest-|house:|external:/);
        const scaled = BigInt(line.amount.replace('.', ''));
        net.set(
          line.unit,
          (net.get(line.unit) ?? 0n) + (line.direction === 'debit' ? -scaled : scaled),
        );
      }
      for (const total of net.values()) expect(total).toBe(0n);
    }

    // A row from before the feed kept its ledger link: no lines, no reference.
    await ctx.pool.query('UPDATE exchange_activity SET transaction_id = NULL');
    const unlinked = await feed(a.cookie);
    const trade = unlinked.find((e) => e.type === 'trade.buy')!;
    expect(trade.entries).toEqual([]);
    expect(trade.reference).toBeNull();
  });
});
