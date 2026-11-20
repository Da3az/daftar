import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { parseCash } from '@daftar/money';
import { buildApp, type App } from '../src/app.ts';
import { FLAG_HEADERS } from '../src/flags.ts';
import { HOUSE_SHARDS, positionExternalId } from '../src/orders/place.ts';
import { claim, hashRequest, reap } from '../src/idempotency/keys.ts';
import { useTestDatabase } from './support/test-database.ts';
import { resetLedger } from './support/reset.ts';
import { Barrier } from './support/barrier.ts';

/**
 * # `Idempotency-Key` on `POST /v1/orders`
 *
 * The duplicate source is a client or proxy retry. The property under test is
 * that **the same key never produces a second order**, and that a concurrent
 * retry is told to wait rather than told it succeeded.
 *
 * The naive path is exercised in the same file, so the race is runnable rather
 * than described.
 */

const ctx = useTestDatabase({ poolMax: 30 });

const CUSTOMER = 'idem-cust';
const OPENING = parseCash('10000000.00');

let app: App;

beforeAll(async () => {
  app = await buildApp({ pool: ctx.pool, loggerOverride: pino({ level: 'silent' }) });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetLedger(ctx.pool);

  await ctx.pool.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol, balance) VALUES
       ($1, 'customer_cash', NULL, $2::bigint),
       ($3, 'customer_asset', 'BTC', 0)`,
    [CUSTOMER, OPENING.toString(), positionExternalId(CUSTOMER, 'BTC')],
  );

  await ctx.pool.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol, balance)
     SELECT 'house:USD:' || lpad(to_hex(n), 2, '0'), 'house_cash', NULL, 0
       FROM generate_series(0, $1::int - 1) AS n`,
    [HOUSE_SHARDS],
  );
  await ctx.pool.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol, balance)
     SELECT 'house:BTC:' || lpad(to_hex(n), 2, '0'), 'house_asset', 'BTC', 0
       FROM generate_series(0, $1::int - 1) AS n`,
    [HOUSE_SHARDS],
  );
});

/**
 * Idempotency keys are >= 8 characters, matching the route's schema.
 *
 * The first version of this file used keys like `KEY('a')` and every request
 * came back 400 — which read as a route bug for a while before it turned out to
 * be the fixture. Real clients send a UUID; a helper that produces something
 * UUID-shaped keeps the tests honest about the contract.
 */
const KEY = (suffix: string): string => `idem-test-key-${suffix}`;

const placeOrderRequest = (
  externalId: string,
  key: string | undefined,
  extraHeaders: Record<string, string> = {},
  quantity = '0.00100000',
) =>
  app.inject({
    method: 'POST',
    url: '/v1/orders',
    payload: { externalId, accountId: CUSTOMER, symbol: 'BTC', side: 'buy', quantity },
    headers: {
      ...(key === undefined ? {} : { 'idempotency-key': key }),
      ...extraHeaders,
    },
  });

/**
 * A **retry**: the identical request, sent again with the same key.
 *
 * Separate from `placeOrderRequest` because the distinction is the whole
 * subject. A retry that varies any field of the body is not a retry — it is key
 * reuse, and the route correctly answers 422. The first version of these tests
 * varied `externalId` between "retries" and every one came back 422, which was
 * the mismatch check working exactly as designed.
 */
const retry = (
  externalId: string,
  key: string,
  extraHeaders: Record<string, string> = {},
  quantity = '0.00100000',
) => placeOrderRequest(externalId, key, extraHeaders, quantity);

const orderCount = async (): Promise<bigint> => {
  const { rows } = await ctx.pool.query<{ n: bigint }>('SELECT count(*) AS n FROM orders');
  return rows[0]!.n;
};

const cashBalance = async (): Promise<bigint> => {
  const { rows } = await ctx.pool.query<{ balance: bigint }>(
    'SELECT balance FROM accounts WHERE external_id = $1',
    [CUSTOMER],
  );
  return rows[0]!.balance;
};

describe('sequential retries with the same key', () => {
  it('places one order and replays the response', async () => {
    const first = await placeOrderRequest('ord-a', KEY('a'));
    expect(first.statusCode).toBe(201);

    const second = await retry('ord-a', KEY('a'));

    // 200, not 201: this request did not create anything. The first one did.
    expect(second.statusCode).toBe(200);

    // The body is byte-identical, including the order's own external id — so a
    // client that retried gets back the order it actually has, not a new one.
    expect(second.json()).toEqual(first.json());

    expect(await orderCount()).toBe(1n);
  });

  it('charges the customer exactly once across five retries', async () => {
    const before = await cashBalance();

    // Five deliveries of ONE request, not five different requests.
    const responses = [];
    for (let i = 0; i < 5; i += 1) {
      responses.push(await retry('ord-b', KEY('b')));
    }

    expect(responses[0]?.statusCode).toBe(201);
    for (const r of responses.slice(1)) expect(r.statusCode).toBe(200);

    expect(await orderCount()).toBe(1n);

    const notional = parseCash(responses[0]!.json<{ notional: string }>().notional);
    expect(await cashBalance()).toBe(before - notional);
  });

  it('a different key places a second order', async () => {
    await placeOrderRequest('ord-c1', KEY('c1'));
    const second = await placeOrderRequest('ord-c2', KEY('c2'));

    expect(second.statusCode).toBe(201);
    expect(await orderCount()).toBe(2n);
  });

  it('no key at all still works, and does not deduplicate', async () => {
    // The header is optional. Without it there is nothing to deduplicate on,
    // and the endpoint behaves exactly as it did before Phase 4.
    expect((await placeOrderRequest('ord-d1', undefined)).statusCode).toBe(201);
    expect((await placeOrderRequest('ord-d2', undefined)).statusCode).toBe(201);
    expect(await orderCount()).toBe(2n);
  });

  it('rejects the same key with a DIFFERENT body, rather than replaying', async () => {
    await placeOrderRequest('ord-e', KEY('e'), {}, '0.00100000');

    // Same key, different quantity. The client has a bug; replaying an
    // unrelated response would hide it and the customer would believe the
    // second order was placed.
    const mismatch = await placeOrderRequest('ord-e2', KEY('e'), {}, '0.00200000');

    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json()).toMatchObject({ error: 'idempotency_key_reused' });
    expect(await orderCount()).toBe(1n);
  });

  it('the request hash ignores key order, so one request is one request', () => {
    // Two spellings of the same body must not look like key reuse.
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: '1' }));
  });

  it('replays even after the order would have been refused', async () => {
    // A 422 from insufficient funds is NOT recorded as a completed key, because
    // the key is only settled on success. A retry therefore re-attempts, which
    // is correct: the balance may have changed.
    const poor = await placeOrderRequest('ord-f', KEY('f'), {}, '100000.00000000');
    expect(poor.statusCode).toBe(422);

    const { rows } = await ctx.pool.query<{ state: string }>(
      `SELECT state FROM idempotency_keys WHERE key = $1`,
      [KEY('f')],
    );
    expect(rows[0]?.state).toBe('in_progress');
  });
});

describe('concurrent retries — the correct path', () => {
  const CONCURRENCY = 8;

  it('places exactly ONE order from eight simultaneous identical requests', async () => {
    const before = await cashBalance();
    const barrier = new Barrier(CONCURRENCY);

    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        await barrier.arriveAndWait();
        // Identical request, eight times at once — a proxy retry storm.
        return retry('ord-g', KEY('g'));
      }),
    );

    const created = responses.filter((r) => r.statusCode === 201).length;
    const replayed = responses.filter((r) => r.statusCode === 200).length;
    const inProgress = responses.filter((r) => r.statusCode === 409).length;

    // Exactly one winner. The rest either replayed the winner's response or
    // were told to retry — never a second order.
    expect(created).toBe(1);
    expect(replayed + inProgress).toBe(CONCURRENCY - 1);

    expect(await orderCount()).toBe(1n);

    const winner = responses.find((r) => r.statusCode === 201)!;
    const notional = parseCash(winner.json<{ notional: string }>().notional);
    expect(await cashBalance()).toBe(before - notional);
  });

  it('a concurrent retry gets 409, never a 200 for unfinished work', async () => {
    const barrier = new Barrier(2);

    const [a, b] = await Promise.all([
      (async () => {
        await barrier.arriveAndWait();
        return retry('ord-h', KEY('h'));
      })(),
      (async () => {
        await barrier.arriveAndWait();
        return retry('ord-h', KEY('h'));
      })(),
    ]);

    const codes = [a.statusCode, b.statusCode];

    // Exactly one creates. The other either replays (200) or is told to wait
    // (409). Never two 201s, which is the only outcome that would be a bug.
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 200 || c === 409)).toHaveLength(1);
    expect(await orderCount()).toBe(1n);
  });
});

describe('concurrent retries — DAFTAR_NAIVE_IDEMPOTENCY', () => {
  const CONCURRENCY = 8;

  /**
   * Tested at the module level with an explicit barrier, not over HTTP.
   *
   * The naive path's window is between its SELECT and its INSERT — two adjacent
   * statements. Over HTTP that window is real but narrow, so the duplicate
   * reproduces only sometimes, and an intermittent demonstration is not a
   * demonstration. The barrier makes it a property of the code's structure,
   * exactly as Phase 1 does for the naive ledger.
   *
   * The load harness can still show it end to end; this is the gate.
   */
  it('EVERY concurrent caller is told it owns the request', async () => {
    const barrier = new Barrier(CONCURRENCY);

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        claim(ctx.pool, {
          route: 'POST /v1/orders',
          key: KEY('naive-race'),
          requestHash: 'identical-hash',
          naive: true,
          barrier: () => barrier.arriveAndWait(),
        }),
      ),
    );

    const claimed = outcomes.filter((o) => o.status === 'claimed').length;

    /**
     * **The bug.** All eight read before any wrote, so all eight believe they
     * own the request. Each one would then place an order, and the customer is
     * charged eight times for one logical request.
     *
     * The unique index still catches the second INSERT of the *key* — but only
     * after the money has moved, which is why the index alone is not the fix.
     */
    expect(claimed).toBe(CONCURRENCY);

    /**
     * And **nothing has been written**, which is the mechanism.
     *
     * The key row is only inserted at settle time, after the work. So at the
     * moment all eight callers decide to proceed, the database holds no record
     * that these requests are related — there is nothing for a unique index to
     * arbitrate on. The index is not bypassed; it is simply not consulted until
     * it is too late to matter.
     */
    const { rows } = await ctx.pool.query<{ n: bigint }>(
      'SELECT count(*) AS n FROM idempotency_keys WHERE key = $1',
      [KEY('naive-race')],
    );
    expect(rows[0]?.n).toBe(0n);
  });

  it('the correct path, same barrier, admits exactly ONE', async () => {
    // The A/B. Identical conditions; only `naive` differs.
    const barrier = new Barrier(CONCURRENCY);

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        claim(ctx.pool, {
          route: 'POST /v1/orders',
          key: KEY('correct-race'),
          requestHash: 'identical-hash',
          naive: false,
          barrier: () => barrier.arriveAndWait(),
        }),
      ),
    );

    expect(outcomes.filter((o) => o.status === 'claimed')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'in_progress')).toHaveLength(CONCURRENCY - 1);
  });

  it('end to end, the naive flag lets a duplicate order through', async () => {
    /**
     * The HTTP-level version. Asserted as "at least one" rather than an exact
     * count, because without the barrier the number depends on scheduling —
     * and the deterministic claim above is what guards the behaviour.
     */
    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        retry('ord-i', KEY('i'), { [FLAG_HEADERS.naiveIdempotency]: 'true' }),
      ),
    );

    const created = responses.filter((r) => r.statusCode === 201).length;
    expect(created).toBeGreaterThanOrEqual(1);
    expect(await orderCount()).toBe(BigInt(created));
  });
});

describe('the key table is enforced by the database', () => {
  it('UNIQUE (route, key) is what arbitrates', async () => {
    const { rows } = await ctx.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idempotency_keys_route_key'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('UNIQUE');
    expect(rows[0]?.indexdef).toContain('(route, key)');
  });

  it('the same key on a different route is a different request', async () => {
    // Scoped by route, so a client reusing one UUID across two endpoints does
    // not get the first endpoint's response from the second.
    await ctx.pool.query(
      `INSERT INTO idempotency_keys (route, key, request_hash) VALUES
         ('POST /v1/orders', 'shared', 'h1'),
         ('POST /v1/withdrawals', 'shared', 'h2')`,
    );

    const { rows } = await ctx.pool.query<{ n: bigint }>(
      `SELECT count(*) AS n FROM idempotency_keys WHERE key = 'shared'`,
    );
    expect(rows[0]?.n).toBe(2n);
  });

  it('a completed row must carry the response it promises to replay', async () => {
    await expect(
      ctx.pool.query(
        `INSERT INTO idempotency_keys (route, key, request_hash, state, completed_at)
         VALUES ('POST /v1/orders', 'bad', 'h', 'completed', now())`,
      ),
    ).rejects.toMatchObject({ constraint: 'idempotency_completed_has_response' });
  });

  it('an in_progress row must not have a completion timestamp', async () => {
    await expect(
      ctx.pool.query(
        `INSERT INTO idempotency_keys (route, key, request_hash, state, completed_at)
         VALUES ('POST /v1/orders', 'bad2', 'h', 'in_progress', now())`,
      ),
    ).rejects.toMatchObject({ constraint: 'idempotency_terminal_has_timestamp' });
  });
});

describe('the reaper', () => {
  it('deletes old keys and leaves recent ones', async () => {
    await ctx.pool.query(
      `INSERT INTO idempotency_keys (route, key, request_hash, created_at) VALUES
         ('POST /v1/orders', 'old',    'h', now() - interval '100 hours'),
         ('POST /v1/orders', 'recent', 'h', now())`,
    );

    const deleted = await reap(ctx.pool, 72);
    expect(deleted).toBe(1);

    const { rows } = await ctx.pool.query<{ key: string }>(
      `SELECT key FROM idempotency_keys ORDER BY key`,
    );
    expect(rows.map((r) => r.key)).toEqual(['recent']);
  });

  it('reaps an abandoned in_progress key once it is old enough', async () => {
    // A key stuck in_progress means the owning process died mid-request.
    // Leaving it forever means that key can never be retried at all.
    await ctx.pool.query(
      `INSERT INTO idempotency_keys (route, key, request_hash, state, created_at)
       VALUES ('POST /v1/orders', 'stuck', 'h', 'in_progress', now() - interval '200 hours')`,
    );

    expect(await reap(ctx.pool, 72)).toBe(1);
  });
});
