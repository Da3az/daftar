import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { parseCash, parseQuantity } from '@daftar/money';
import { buildApp, type App } from '../src/app.ts';
import { useTestDatabase } from './support/test-database.ts';
import { resetInstruments, resetLedger } from './support/reset.ts';
import { HOUSE_SHARDS, placeOrder, positionExternalId } from '../src/orders/place.ts';
import { hashRawBody } from '../src/webhooks/signature.ts';

const ctx = useTestDatabase({ poolMax: 10 });

const CUSTOMER = 'rep-cust-1';
const OTHER = 'rep_cust_1';
const OPENING = parseCash('1000000.00');

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
  await resetInstruments(ctx.pool);

  /**
   * Two customers whose ids differ **only** by `-` versus `_`.
   *
   * `_` is a single-character wildcard in SQL `LIKE`, and `ExternalId` permits
   * it, so a prefix match written as `LIKE $1 || ':%'` reports one customer's
   * positions as the other's. This fixture is the regression test for that.
   */
  await ctx.pool.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol, balance) VALUES
       ($1, 'customer_cash',   NULL, $3::bigint),
       ($2, 'customer_asset', 'BTC', 0),
       ($4, 'customer_cash',   NULL, $3::bigint),
       ($5, 'customer_asset', 'BTC', 500000000)`,
    [
      CUSTOMER,
      positionExternalId(CUSTOMER, 'BTC'),
      OPENING.toString(),
      OTHER,
      positionExternalId(OTHER, 'BTC'),
    ],
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

const buy = (externalId: string, quantity: string) =>
  placeOrder(ctx.pool, {
    externalId,
    cashAccountExternalId: CUSTOMER,
    symbol: 'BTC',
    side: 'buy',
    quantity: parseQuantity(quantity),
    mode: 'serializable',
  });

describe('GET /v1/accounts/:externalId/statement', () => {
  it('returns a running balance that ends at the account balance', async () => {
    await buy('rep-1', '0.10000000');
    await buy('rep-2', '0.20000000');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${CUSTOMER}/statement?limit=50`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      account: { unit: string };
      rows: { amount: string; runningBalance: string; direction: string }[];
    }>();

    expect(body.account.unit).toBe('USD');
    expect(body.rows).toHaveLength(2);

    // Both are debits, so both are negative, and the last running balance is
    // the sum. Compared as strings — the point of the endpoint is that it never
    // hands a caller a float.
    const { rows } = await ctx.pool.query<{ balance: bigint }>(
      'SELECT balance FROM accounts WHERE external_id = $1',
      [CUSTOMER],
    );
    const spent = OPENING - rows[0]!.balance;

    expect(body.rows.at(-1)!.runningBalance).toBe(`-${(Number(spent) / 100).toFixed(2)}`);
    expect(body.rows.every((r) => r.direction === 'debit')).toBe(true);
  });

  it('formats each entry with its own unit scale, not the account unit', async () => {
    await buy('rep-unit', '0.10000000');

    const asset = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${positionExternalId(CUSTOMER, 'BTC')}/statement`,
    });

    const body = asset.json<{ rows: { unit: string; amount: string }[] }>();

    /*
     * 8 fractional digits, not 2. An asset quantity formatted with the cash
     * scale is wrong by a factor of a million and still looks like a plausible
     * number, which is why `formatByUnit` dispatches on the row's own unit.
     */
    expect(body.rows[0]!.unit).toBe('BTC');
    expect(body.rows[0]!.amount).toBe('0.10000000');
  });

  it('404s for an account that does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/accounts/nope-9999/statement' });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe('unknown_account');
  });

  it('rejects a limit above the ceiling rather than silently clamping it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${CUSTOMER}/statement?limit=5000`,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /v1/accounts/:externalId/positions', () => {
  it('reports cash, quantity and an average cost basis', async () => {
    await buy('rep-pos-1', '0.10000000');
    await buy('rep-pos-2', '0.10000000');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${CUSTOMER}/positions`,
    });

    const body = response.json<{
      cash: string;
      positions: { symbol: string; quantity: string; costBasis: string | null }[];
    }>();

    expect(body.positions).toHaveLength(1);
    expect(body.positions[0]!.symbol).toBe('BTC');
    expect(body.positions[0]!.quantity).toBe('0.20000000');

    /*
     * 95432.20, **not** 95432.17 — and it is not a rounding bug.
     *
     * Each order's notional is rounded to whole cents when the order is
     * written: 0.1 BTC at 95432.17 is 9543.217, stored as 9543.22. Two of those
     * is 19086.44 for 0.2 BTC, which averages to 95432.20 per whole unit.
     *
     * So the average cost basis of a position legitimately differs from the
     * price every one of its orders was filled at, because the rounding happens
     * per order and the average is taken afterwards. Worth asserting exactly,
     * since a loose matcher here would hide a real change in how notional is
     * computed.
     */
    expect(body.positions[0]!.costBasis).toBe('95432.20');
  });

  it('does not leak another account whose id differs only by a LIKE wildcard', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${CUSTOMER}/positions`,
    });

    const body = response.json<{ positions: { symbol: string; quantity: string }[] }>();

    /*
     * `rep_cust_1` holds 5 BTC and `rep-cust-1` holds nothing. With a `LIKE`
     * prefix match, `rep_cust_1:BTC` matches the pattern built from
     * `rep-cust-1` and this came back as 5.00000000.
     */
    expect(body.positions).toHaveLength(0);
  });

  it('omits an asset the customer has never held rather than showing zero', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${CUSTOMER}/positions`,
    });

    const body = response.json<{ positions: { symbol: string }[] }>();
    expect(body.positions.map((p) => p.symbol)).not.toContain('ETH');
  });

  it('404s for a position account, which has no positions of its own', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${positionExternalId(CUSTOMER, 'BTC')}/positions`,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /v1/accounts/:externalId/transactions', () => {
  it('returns every leg of each transaction, summing to zero per unit', async () => {
    await buy('rep-tx-1', '0.10000000');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${CUSTOMER}/transactions?limit=10`,
    });

    const body = response.json<{
      transactions: {
        legs: { unit: string; amount: string; direction: string }[];
        order: { externalId: string; price: string } | null;
      }[];
    }>();

    expect(body.transactions).toHaveLength(1);
    const legs = body.transactions[0]!.legs;

    // Four legs across two units — two USD, two BTC.
    expect(legs).toHaveLength(4);

    const sumFor = (unit: string): number =>
      legs
        .filter((l) => l.unit === unit)
        .reduce((total, l) => total + Number(l.amount.replace('.', '')), 0);

    expect(sumFor('USD')).toBe(0);
    expect(sumFor('BTC')).toBe(0);

    expect(body.transactions[0]!.order?.externalId).toBe('rep-tx-1');
  });

  it('paginates by cursor, never repeating or skipping a transaction', async () => {
    for (let i = 0; i < 5; i += 1) await buy(`rep-page-${String(i)}`, '0.01000000');

    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page += 1) {
      /*
       * `: string` is load-bearing, not decoration.
       *
       * Fastify's `inject` infers the response type from the `url` literal, so
       * without the annotation TypeScript has a cycle to resolve —
       * `url` → `response` → `body` → `cursor` → `url` — and gives up with
       * TS7022 ("implicitly has type 'any' because it is referenced directly or
       * indirectly in its own initializer"). Everything downstream then becomes
       * `any` and the test silently stops checking anything.
       */
      const url: string =
        `/v1/accounts/${CUSTOMER}/transactions?limit=2` +
        (cursor === null ? '' : `&before=${cursor}`);

      const response = await app.inject({ method: 'GET', url });
      const body = response.json<{
        transactions: { id: string }[];
        nextCursor: string | null;
      }>();

      seen.push(...body.transactions.map((t) => t.id));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);

    // Descending by id, which is what makes the cursor total.
    const ids = seen.map((id) => BigInt(id));
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
  });

  it('returns a null cursor on a short page', async () => {
    await buy('rep-short', '0.01000000');

    const body = (
      await app.inject({
        method: 'GET',
        url: `/v1/accounts/${CUSTOMER}/transactions?limit=50`,
      })
    ).json<{ nextCursor: string | null }>();

    expect(body.nextCursor).toBeNull();
  });
});

describe('GET /v1/webhooks/events', () => {
  it('reports a redelivery as a duplicate with the delivery count', async () => {
    /*
     * `processed_at` is set explicitly. `processed` is a terminal state and the
     * `webhook_terminal_has_timestamp` check constraint requires a timestamp
     * with it — a terminal row with no timestamp is precisely what that
     * constraint exists to forbid, so the fixture satisfies it rather than
     * working around it.
     */
    await ctx.pool.query(
      `INSERT INTO webhook_events
         (provider, idempotency_key, object_id, event_type, payload_hash, payload,
          signature_valid, within_window, state, delivery_count, processed_at)
       VALUES ('simbank', 'evt-dup', 'obj-dup', 'funding.succeeded',
               'abcdef0123456789abcdef', '{}'::jsonb, true, true, 'processed', 3, now())`,
    );

    const body = (await app.inject({ method: 'GET', url: '/v1/webhooks/events?limit=10' })).json<{
      events: { eventId: string; duplicate: boolean; deliveryCount: number; payloadHash: string }[];
    }>();

    const event = body.events.find((e) => e.eventId === 'evt-dup');
    expect(event?.duplicate).toBe(true);
    expect(event?.deliveryCount).toBe(3);

    // Truncated, so it cannot be mistaken for the digest the signature covers.
    expect(event?.payloadHash).toHaveLength(16);
  });

  it('includes a rejected delivery rather than dropping it', async () => {
    await ctx.pool.query(
      `INSERT INTO webhook_events
         (provider, idempotency_key, object_id, event_type, payload_hash, payload,
          signature_valid, within_window, state)
       VALUES ('simbank', 'evt-stale', 'obj-stale', 'funding.succeeded',
               'deadbeefdeadbeefdead', '{}'::jsonb, true, false, 'received')`,
    );

    const body = (await app.inject({ method: 'GET', url: '/v1/webhooks/events' })).json<{
      events: { eventId: string; withinWindow: boolean }[];
    }>();

    const event = body.events.find((e) => e.eventId === 'evt-stale');
    expect(event).toBeDefined();
    expect(event?.withinWindow).toBe(false);
  });
});

describe('POST /v1/webhooks/events/:id/replay', () => {
  it('re-delivers through the real path and is answered as a duplicate', async () => {
    const payload = { id: 'evt-replay', type: 'payout.succeeded', objectId: 'obj-replay' };

    /**
     * The stored hash is the **real** hash of the bytes the replay will send.
     *
     * The first version of this fixture used a made-up hash string, and the
     * replay came back 409 `payload_conflict` — correctly. Same event id,
     * different payload hash is exactly the tampering case the endpoint is
     * built to catch, and it caught the test's own fake data.
     *
     * It is also the honest limit of the Replay button: the original raw bytes
     * are not retained, so a replay re-serialises from `jsonb` and only matches
     * when the provider's formatting agreed with `JSON.stringify`. Noted in the
     * route's own comment.
     */
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');

    const { rows } = await ctx.pool.query<{ id: bigint }>(
      `INSERT INTO webhook_events
         (provider, idempotency_key, object_id, event_type, payload_hash, payload,
          signature_valid, within_window, state, processed_at)
       VALUES ('simbank', 'evt-replay', 'obj-replay', 'payout.succeeded',
               $1, $2::jsonb, true, true, 'ignored', now())
       RETURNING id`,
      [hashRawBody(raw), JSON.stringify(payload)],
    );

    const response = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/events/${rows[0]!.id.toString()}/replay`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      replayed: boolean;
      status: number;
      body: { duplicate: boolean; deliveryCount: number };
    }>();

    /*
     * 200 and `duplicate: true` is the **correct** answer, not a failure. The
     * replay really went through signature verification and the unique index;
     * the index is what decided it was a repeat.
     */
    expect(body.replayed).toBe(true);
    expect(body.status).toBe(200);
    expect(body.body.duplicate).toBe(true);
    expect(body.body.deliveryCount).toBe(2);
  });

  it('404s for an event id that does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/events/99999999/replay',
    });
    expect(response.statusCode).toBe(404);
  });
});
