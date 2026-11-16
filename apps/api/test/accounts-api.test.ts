import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { buildApp, type App } from '../src/app.ts';
import { FLAG_HEADERS } from '../src/flags.ts';
import { useTestDatabase } from './support/test-database.ts';

const ctx = useTestDatabase({ poolMax: 20 });

let app: App;

beforeAll(async () => {
  app = await buildApp({ pool: ctx.pool, loggerOverride: pino({ level: 'silent' }) });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await ctx.pool.query('DELETE FROM accounts');
});

const createAccount = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/accounts', payload: body });

const readAccount = (externalId: string) =>
  app.inject({ method: 'GET', url: `/v1/accounts/${externalId}` });

const postDebit = (externalId: string, amount: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: `/v1/accounts/${externalId}/debits`,
    payload: { amount },
    headers,
  });

describe('POST /v1/accounts', () => {
  it('creates a cash account with an opening balance', async () => {
    const res = await createAccount({
      externalId: 'cash-0001',
      kind: 'customer_cash',
      openingBalance: '1000.00',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      externalId: 'cash-0001',
      kind: 'customer_cash',
      assetSymbol: null,
      balance: '1000.00',
    });
  });

  it('defaults the opening balance to zero', async () => {
    const res = await createAccount({ externalId: 'cash-0002', kind: 'customer_cash' });
    expect(res.json<{ balance: string }>().balance).toBe('0.00');
  });

  it('returns 409 on a duplicate, decided by the unique index', async () => {
    await createAccount({ externalId: 'dup', kind: 'customer_cash' });
    const res = await createAccount({ externalId: 'dup', kind: 'house_cash' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'account_exists' });
  });

  it('returns 409 for an asset account with no symbol, decided by the CHECK', async () => {
    const res = await createAccount({ externalId: 'asset-nosym', kind: 'customer_asset' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'invalid_account' });
  });

  it('accepts an asset account with a symbol', async () => {
    const res = await createAccount({
      externalId: 'btc-0001',
      kind: 'customer_asset',
      assetSymbol: 'BTC',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ assetSymbol: 'BTC' });
  });
});

describe('amounts on the wire', () => {
  it('accepts an exact decimal string', async () => {
    const res = await createAccount({
      externalId: 'exact',
      kind: 'customer_cash',
      openingBalance: '92233720368547758.07',
    });

    // 2^63 - 1 minor units, the top of int8, round-tripped with every digit.
    expect(res.statusCode).toBe(201);
    expect(res.json<{ balance: string }>().balance).toBe('92233720368547758.07');
  });

  it('rejects a JSON number, which is the whole point of the string contract', async () => {
    // A JSON number is an IEEE-754 double in every mainstream parser, so an
    // amount above 2^53 minor units is rounded by the *client's* parser before
    // the server ever sees it. There is no server-side fix; the contract has to
    // forbid the type.
    const res = await createAccount({
      externalId: 'numeric',
      kind: 'customer_cash',
      openingBalance: 1000.0,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_failed' });
  });

  it.each([
    ['1.005', 'more fractional digits than the scale'],
    ['1e3', 'exponent form'],
    ['', 'empty string'],
    [' 100.00 ', 'surrounding whitespace'],
    ['1,000.00', 'grouping separators'],
    ['0.00', 'zero — a debit must be positive'],
    ['-100.00', 'negative'],
    ['NaN', 'NaN'],
    ['0x10', 'hex'],
  ])('rejects %j (%s)', async (amount) => {
    await createAccount({ externalId: 'wire', kind: 'customer_cash', openingBalance: '10.00' });
    const res = await postDebit('wire', amount);

    expect(res.statusCode).toBe(400);
  });

  it('never emits a JSON number for an amount', async () => {
    await createAccount({
      externalId: 'shape',
      kind: 'customer_cash',
      openingBalance: '1234.56',
    });

    const res = await readAccount('shape');
    // Inspect the raw payload: a serializer that emitted 1234.56 unquoted would
    // still pass a `toBe('1234.56')` assertion after JSON.parse coerced it back.
    expect(res.body).toContain('"balance":"1234.56"');
    expect(res.body).not.toContain('"balance":1234.56');
  });
});

describe('POST /v1/accounts/:externalId/debits', () => {
  beforeEach(async () => {
    await createAccount({
      externalId: 'debit-me',
      kind: 'customer_cash',
      openingBalance: '1000.00',
    });
  });

  it('applies a debit and reports both balances', async () => {
    const res = await postDebit('debit-me', '250.00');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'applied',
      strategy: 'guarded_atomic',
      balanceBefore: '1000.00',
      balanceAfter: '750.00',
    });
  });

  it('refuses an over-balance debit with 422, not 409 or 500', async () => {
    const res = await postDebit('debit-me', '1000.01');

    // Well-formed request, existing resource, state cannot satisfy it. A load
    // harness has to tell this apart from a 404 and a 500 without parsing a
    // body.
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      status: 'insufficient_funds',
      balanceBefore: '1000.00',
      balanceAfter: '1000.00',
    });

    expect((await readAccount('debit-me')).json<{ balance: string }>().balance).toBe('1000.00');
  });

  it('404s on an unknown account', async () => {
    const res = await postDebit('nope', '1.00');
    expect(res.statusCode).toBe(404);
  });

  it('is exact at the top of int8', async () => {
    await createAccount({
      externalId: 'huge',
      kind: 'customer_cash',
      openingBalance: '92233720368547758.07',
    });

    const res = await postDebit('huge', '0.07');
    expect(res.json()).toMatchObject({
      balanceBefore: '92233720368547758.07',
      balanceAfter: '92233720368547758.00',
    });
  });
});

describe('the naive flags select a different implementation per request', () => {
  beforeEach(async () => {
    await createAccount({ externalId: 'flagged', kind: 'customer_cash', openingBalance: '10.00' });
  });

  it('reports which strategy ran, so a result is never ambiguous', async () => {
    expect((await postDebit('flagged', '1.00')).json()).toMatchObject({
      strategy: 'guarded_atomic',
    });

    expect(
      (await postDebit('flagged', '1.00', { [FLAG_HEADERS.naiveOverdraft]: 'true' })).json(),
    ).toMatchObject({ strategy: 'naive_overdraft' });

    expect(
      (await postDebit('flagged', '1.00', { [FLAG_HEADERS.naiveLostUpdate]: 'true' })).json(),
    ).toMatchObject({ strategy: 'naive_lost_update' });
  });

  it('all three strategies agree on a SINGLE request — the bugs need concurrency', async () => {
    /**
     * Worth asserting explicitly, because it is the thing that makes the naive
     * paths realistic rather than strawmen.
     *
     * With one request in flight there is no concurrent writer, so the naive
     * paths' application-level funds check is **not stale** — it is correct, and
     * it refuses, exactly like the guarded path. Sequential tests on these
     * implementations pass. That is why the bug ships.
     *
     * The divergence appears only when two or more transactions read before
     * either writes, which is what the deterministic barrier test and the k6
     * harness arrange.
     */
    for (const headers of [
      {},
      { [FLAG_HEADERS.naiveOverdraft]: 'true' },
      { [FLAG_HEADERS.naiveLostUpdate]: 'true' },
    ]) {
      const over = await postDebit('flagged', '50.00', headers);
      expect(over.statusCode, JSON.stringify(headers)).toBe(422);
      expect((await readAccount('flagged')).json<{ balance: string }>().balance).toBe('10.00');

      const within = await postDebit('flagged', '4.00', headers);
      expect(within.statusCode).toBe(200);
      expect(within.json()).toMatchObject({ balanceAfter: '6.00' });

      await ctx.pool.query(`UPDATE accounts SET balance = 1000 WHERE external_id = 'flagged'`);
    }
  });

  it('flags are per request: consecutive requests take different code paths', async () => {
    const first = await postDebit('flagged', '1.00', {
      [FLAG_HEADERS.naiveOverdraft]: 'true',
    });
    expect(first.json()).toMatchObject({ strategy: 'naive_overdraft', balanceAfter: '9.00' });

    // No header on this one. No restart, no reconfiguration, no redeploy.
    const second = await postDebit('flagged', '1.00');
    expect(second.json()).toMatchObject({ strategy: 'guarded_atomic', balanceAfter: '8.00' });

    const third = await postDebit('flagged', '1.00', {
      [FLAG_HEADERS.naiveLostUpdate]: 'true',
    });
    expect(third.json()).toMatchObject({ strategy: 'naive_lost_update', balanceAfter: '7.00' });
  });

  it('naive_overdraft wins if both naive flags are set', async () => {
    const res = await postDebit('flagged', '1.00', {
      [FLAG_HEADERS.naiveOverdraft]: 'true',
      [FLAG_HEADERS.naiveLostUpdate]: 'true',
    });

    // Deterministic rather than an arbitrary mix of two broken paths.
    expect(res.json()).toMatchObject({ strategy: 'naive_overdraft' });
  });
});

describe('the debit route in the OpenAPI document', () => {
  it('declares amounts as strings, not numbers', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    const doc = res.json<{
      paths: Record<
        string,
        Record<
          string,
          { requestBody?: { content: Record<string, { schema: Record<string, unknown> }> } }
        >
      >;
    }>();

    const schema =
      doc.paths['/v1/accounts/{externalId}/debits']?.['post']?.requestBody?.content[
        'application/json'
      ]?.schema;

    expect(schema).toBeDefined();
    const amount = (schema as { properties: Record<string, { type: string }> }).properties[
      'amount'
    ];
    expect(amount?.type).toBe('string');
  });

  it('documents what each naive flag actually does', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    const doc = res.json<{
      paths: Record<string, Record<string, { description?: string }>>;
    }>();

    const description = doc.paths['/v1/accounts/{externalId}/debits']?.['post']?.description ?? '';

    expect(description).toContain('zero lost updates');
    expect(description).toContain('Loses updates');
    expect(description).toContain('READ COMMITTED');
  });
});
