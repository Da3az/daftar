import { beforeEach, describe, expect, it } from 'vitest';
import { formatCash, parseCash, parseQuantity } from '@daftar/money';
import { useTestDatabase } from './support/test-database.ts';
import { resetInstruments, resetLedger } from './support/reset.ts';
import { Barrier } from './support/barrier.ts';
import {
  HOUSE_SHARDS,
  houseAssetShardExternalId,
  houseCashExternalId,
  houseShardOf,
  placeOrder,
  positionExternalId,
} from '../src/orders/place.ts';
import { LEDGER_CONCURRENCY_MODES } from '../src/env.ts';

const ctx = useTestDatabase({ poolMax: 30 });

const CUSTOMER = 'cust-1';
const OPENING = parseCash('1000000.00');

/** The seeded BTC reference price, from migration 0005. */
const BTC_PRICE = 9_543_217n; // 95,432.17

beforeEach(async () => {
  await resetLedger(ctx.pool);

  await resetInstruments(ctx.pool);

  await ctx.pool.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol, balance) VALUES
       ($1, 'customer_cash',   NULL,  $2::bigint),
       ($3, 'customer_asset', 'BTC',  0)`,
    [CUSTOMER, OPENING.toString(), positionExternalId(CUSTOMER, 'BTC')],
  );

  // All 16 house shards per unit, as migration 0006 creates them. Creating only
  // the one shard this customer maps to would make the fixture depend on the id
  // the identity column happened to hand out.
  await ctx.pool.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol, balance)
     SELECT 'house:USD:' || lpad(to_hex(n), 2, '0'), 'house_cash', NULL, 0
       FROM generate_series(0, $1::int - 1) AS n`,
    [HOUSE_SHARDS],
  );
  await ctx.pool.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol, balance)
     SELECT 'house:' || $2 || ':' || lpad(to_hex(n), 2, '0'), 'house_asset', $2, 0
       FROM generate_series(0, $1::int - 1) AS n`,
    [HOUSE_SHARDS, 'BTC'],
  );
});

/** The house shard this test's customer maps to. */
const customerShard = async (): Promise<string> => {
  const { rows } = await ctx.pool.query<{ id: bigint }>(
    'SELECT id FROM accounts WHERE external_id = $1',
    [CUSTOMER],
  );
  return houseShardOf(rows[0]!.id);
};

const balanceOf = async (externalId: string): Promise<bigint> => {
  const { rows } = await ctx.pool.query<{ balance: bigint }>(
    'SELECT balance FROM accounts WHERE external_id = $1',
    [externalId],
  );
  return rows[0]!.balance;
};

const buy = (externalId: string, quantity: string, mode = 'serializable' as const) =>
  placeOrder(ctx.pool, {
    externalId,
    cashAccountExternalId: CUSTOMER,
    symbol: 'BTC',
    side: 'buy',
    quantity: parseQuantity(quantity),
    mode,
  });

describe('placing an order', () => {
  it('writes four entries — two in USD, two in BTC — and the order row, atomically', async () => {
    const result = await buy('ord-1', '0.5');

    expect(result.status).toBe('placed');
    if (result.status !== 'placed') return;

    // 0.5 BTC at 95,432.17 = 47,716.085 -> 47,716.09 (half away from zero)
    expect(formatCash(result.order.notional)).toBe('47716.09');
    expect(result.order.price).toBe(BTC_PRICE);

    const { rows } = await ctx.pool.query<{ unit: string; n: bigint; net: bigint }>(
      `SELECT unit, count(*) AS n, sum(amount)::bigint AS net
         FROM entries GROUP BY unit ORDER BY unit`,
    );

    expect(rows).toEqual([
      { unit: 'BTC', n: 2n, net: 0n },
      { unit: 'USD', n: 2n, net: 0n },
    ]);

    const { rows: orderRows } = await ctx.pool.query<{ n: bigint; transaction_id: bigint }>(
      'SELECT count(*) AS n, max(transaction_id) AS transaction_id FROM orders',
    );
    expect(orderRows[0]?.n).toBe(1n);
    expect(orderRows[0]?.transaction_id).toBe(result.order.transactionId);
  });

  it('moves cash and quantity in opposite directions', async () => {
    const result = await buy('ord-2', '0.5');
    if (result.status !== 'placed') throw new Error('expected placed');

    expect(await balanceOf(CUSTOMER)).toBe(OPENING - result.order.notional);
    const shard = await customerShard();
    expect(await balanceOf(houseCashExternalId(shard))).toBe(result.order.notional);
    expect(await balanceOf(positionExternalId(CUSTOMER, 'BTC'))).toBe(parseQuantity('0.5'));
    expect(await balanceOf(houseAssetShardExternalId('BTC', shard))).toBe(-parseQuantity('0.5'));
  });

  it('a sell reverses both directions', async () => {
    await buy('ord-3', '1');

    const result = await placeOrder(ctx.pool, {
      externalId: 'ord-4',
      cashAccountExternalId: CUSTOMER,
      symbol: 'BTC',
      side: 'sell',
      quantity: parseQuantity('0.25'),
      mode: 'serializable',
    });

    expect(result.status).toBe('placed');
    expect(await balanceOf(positionExternalId(CUSTOMER, 'BTC'))).toBe(parseQuantity('0.75'));
  });

  it('refuses a buy the cash cannot cover, writing nothing', async () => {
    const result = await buy('ord-5', '1000');

    expect(result.status).toBe('insufficient_funds');
    expect(await balanceOf(CUSTOMER)).toBe(OPENING);

    const { rows } = await ctx.pool.query<{ n: bigint }>('SELECT count(*) AS n FROM orders');
    // No order row either: it is written inside the same transaction.
    expect(rows[0]?.n).toBe(0n);
  });

  it('refuses a sell of a position that is not held', async () => {
    const result = await placeOrder(ctx.pool, {
      externalId: 'ord-6',
      cashAccountExternalId: CUSTOMER,
      symbol: 'BTC',
      side: 'sell',
      quantity: parseQuantity('1'),
      mode: 'serializable',
    });

    expect(result.status).toBe('insufficient_funds');
  });

  it('rejects a quantity whose notional rounds to zero, before doing any work', async () => {
    // 1 satoshi of ARB at 0.87 is 0.0000000087 cash.
    await ctx.pool.query(
      // The enum casts are required: across a UNION ALL, PostgreSQL resolves the
      // column type from the branches and infers `text` for a bare literal,
      // which then will not assign to an account_kind column.
      `INSERT INTO accounts (external_id, kind, asset_symbol)
       SELECT $1, 'customer_asset'::account_kind, 'ARB'
       UNION ALL
       SELECT 'house:ARB:' || lpad(to_hex(n), 2, '0'), 'house_asset'::account_kind, 'ARB'
         FROM generate_series(0, $2::int - 1) AS n`,
      [positionExternalId(CUSTOMER, 'ARB'), HOUSE_SHARDS],
    );

    const result = await placeOrder(ctx.pool, {
      externalId: 'ord-7',
      cashAccountExternalId: CUSTOMER,
      symbol: 'ARB',
      side: 'buy',
      quantity: 1n,
      mode: 'serializable',
    });

    // Caught before BEGIN. At COMMIT it would have surfaced as
    // entries_amount_nonzero — a constraint name, after all the work.
    expect(result.status).toBe('quantity_rounds_to_zero');
    const { rows } = await ctx.pool.query<{ n: bigint }>(
      'SELECT count(*) AS n FROM ledger_transactions',
    );
    expect(rows[0]?.n).toBe(0n);
  });

  it('reports an unknown instrument separately from an unknown account', async () => {
    expect(
      (
        await placeOrder(ctx.pool, {
          externalId: 'ord-8',
          cashAccountExternalId: CUSTOMER,
          symbol: 'DOGE',
          side: 'buy',
          quantity: parseQuantity('1'),
          mode: 'serializable',
        })
      ).status,
    ).toBe('unknown_instrument');

    expect(
      (
        await placeOrder(ctx.pool, {
          externalId: 'ord-9',
          cashAccountExternalId: 'nobody',
          symbol: 'BTC',
          side: 'buy',
          quantity: parseQuantity('1'),
          mode: 'serializable',
        })
      ).status,
    ).toBe('unknown_account');
  });

  it('rejects a non-positive quantity', async () => {
    await expect(
      placeOrder(ctx.pool, {
        externalId: 'ord-10',
        cashAccountExternalId: CUSTOMER,
        symbol: 'BTC',
        side: 'buy',
        quantity: 0n,
        mode: 'serializable',
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe('house account sharding', () => {
  /**
   * The mapping exists twice: `houseShardOf()` in TypeScript, and
   * `lpad(to_hex(cash.id % $n), 2, '0')` inside `resolve()`'s SQL. The SQL form
   * is needed because the shard depends on `cash.id`, which that same query is
   * discovering — doing it in TypeScript would cost a second round trip on the
   * measured write path.
   *
   * Two implementations of one mapping is how a shard split appears silently:
   * half the orders go to one shard and half to another, both transactions
   * balance, every invariant holds, and the house's position is spread across a
   * row nobody is looking at. So they are asserted to agree.
   */
  it('the TypeScript and SQL shard mappings agree', async () => {
    const ids = [0n, 1n, 15n, 16n, 17n, 255n, 256n, 1000n, 123456789n, 9223372036854775807n];

    const { rows } = await ctx.pool.query<{ id: bigint; shard: string }>(
      `SELECT id, lpad(to_hex(id % $2::bigint), 2, '0') AS shard
         FROM unnest($1::bigint[]) AS id`,
      [ids.map((i) => i.toString()), String(HOUSE_SHARDS)],
    );

    expect(rows).toHaveLength(ids.length);
    for (const row of rows) {
      expect(houseShardOf(row.id), `id ${row.id.toString()}`).toBe(row.shard);
    }
  });

  it('spreads customers across shards rather than onto one row', async () => {
    // The whole point of the change. Create enough customers to cover every
    // shard and check that they land on more than one.
    const ids: string[] = [];
    for (let i = 0; i < HOUSE_SHARDS * 3; i += 1) ids.push(`shardtest-${String(i)}`);

    const { rows } = await ctx.pool.query<{ id: bigint }>(
      `INSERT INTO accounts (external_id, kind, balance)
       SELECT x, 'customer_cash', 0 FROM unnest($1::text[]) AS x
       RETURNING id`,
      [ids],
    );

    const shards = new Set(rows.map((r) => houseShardOf(r.id)));
    // Sequential identity ids modulo 16 cover every shard exactly.
    expect(shards.size).toBe(HOUSE_SHARDS);
  });

  it('the house position is the sum across shards, and the view says so', async () => {
    await buy('shard-sum-1', '0.25');
    await buy('shard-sum-2', '0.25');

    const { rows } = await ctx.pool.query<{
      unit: string;
      shard_count: bigint;
      stored_balance: bigint;
    }>('SELECT unit, shard_count, stored_balance FROM house_positions ORDER BY unit');

    const usd = rows.find((r) => r.unit === 'USD')!;
    const btc = rows.find((r) => r.unit === 'BTC')!;

    expect(usd.shard_count).toBe(BigInt(HOUSE_SHARDS));
    // The house took in the cash and gave out the quantity.
    expect(usd.stored_balance).toBeGreaterThan(0n);
    expect(btc.stored_balance).toBe(-parseQuantity('0.5'));
  });

  it('a customer always maps to the same shard, preserving per-account order', async () => {
    const before = await customerShard();
    await buy('stable-1', '0.1');
    await buy('stable-2', '0.1');
    const after = await customerShard();

    expect(after).toBe(before);

    // Both orders' house legs landed on that one shard, not spread about.
    const { rows } = await ctx.pool.query<{ n: bigint }>(
      `SELECT count(DISTINCT a.external_id) AS n
         FROM entries e JOIN accounts a ON a.id = e.account_id
        WHERE a.kind IN ('house_cash', 'house_asset')`,
    );
    expect(rows[0]?.n).toBe(2n); // one USD shard + one BTC shard
  });
});

describe('the frozen price', () => {
  it('is snapshotted into the order and used by the entries', async () => {
    const result = await buy('frozen-1', '1');
    if (result.status !== 'placed') throw new Error('expected placed');

    const { rows } = await ctx.pool.query<{ price: bigint; notional: bigint }>(
      'SELECT price, notional FROM orders WHERE external_id = $1',
      ['frozen-1'],
    );

    expect(rows[0]?.price).toBe(BTC_PRICE);
    expect(rows[0]?.notional).toBe(BTC_PRICE); // 1 whole unit
  });

  it('a later price change does NOT alter an existing order', async () => {
    const first = await buy('frozen-2', '1');
    if (first.status !== 'placed') throw new Error('expected placed');

    // The market moves.
    await ctx.pool.query(
      `UPDATE instruments SET reference_price = $1::bigint WHERE symbol = 'BTC'`,
      [(BTC_PRICE * 2n).toString()],
    );

    const { rows } = await ctx.pool.query<{ price: bigint }>(
      'SELECT price FROM orders WHERE external_id = $1',
      ['frozen-2'],
    );

    // The order still records what the customer was charged.
    expect(rows[0]?.price).toBe(BTC_PRICE);

    // A new order picks up the new price, which is also correct.
    const second = await buy('frozen-3', '1');
    if (second.status !== 'placed') throw new Error('expected placed');
    expect(second.order.price).toBe(BTC_PRICE * 2n);
  });

  it('two orders at the same price produce byte-identical amounts', async () => {
    // The reproducibility property every evidence file depends on. With a live
    // price lookup these would differ and no benchmark would be comparable.
    const a = await buy('repro-1', '0.333');
    const b = await buy('repro-2', '0.333');

    if (a.status !== 'placed' || b.status !== 'placed') throw new Error('expected placed');
    expect(a.order.notional).toBe(b.order.notional);
    expect(a.order.price).toBe(b.order.price);
  });
});

describe.each(LEDGER_CONCURRENCY_MODES)('%s — concurrent orders on one account', (mode) => {
  const CONCURRENCY = 10;

  it('never overdraws and the ledger always balances', async () => {
    // Fund exactly 5 orders' worth.
    const quantity = parseQuantity('1');
    const perOrder = BTC_PRICE;
    await ctx.pool.query('UPDATE accounts SET balance = $1::bigint WHERE external_id = $2', [
      (perOrder * 5n).toString(),
      CUSTOMER,
    ]);

    const barrier = new Barrier(CONCURRENCY);

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        placeOrder(ctx.pool, {
          externalId: `conc-${mode}-${String(i)}`,
          cashAccountExternalId: CUSTOMER,
          symbol: 'BTC',
          side: 'buy',
          quantity,
          mode,
          maxAttempts: 25,
          barrier: () => barrier.arriveAndWait(),
        }),
      ),
    );

    const placed = results.filter((r) => r.status === 'placed').length;
    const refused = results.filter((r) => r.status === 'insufficient_funds').length;

    expect(placed).toBe(5);
    expect(refused).toBe(5);
    expect(await balanceOf(CUSTOMER)).toBe(0n);

    // Every unit nets to zero across the whole system, always.
    const { rows } = await ctx.pool.query<{ unit: string; net_amount: bigint }>(
      'SELECT unit, net_amount FROM ledger_totals_by_unit ORDER BY unit',
    );
    expect(rows).toEqual([
      { unit: 'BTC', net_amount: 0n },
      { unit: 'USD', net_amount: 0n },
    ]);

    // One order row per successful placement, no more.
    const { rows: orderRows } = await ctx.pool.query<{ n: bigint }>(
      'SELECT count(*) AS n FROM orders',
    );
    expect(orderRows[0]?.n).toBe(BigInt(placed));
  });

  it('the stored snapshots agree with the entries behind them', async () => {
    await ctx.pool.query('UPDATE accounts SET balance = 0');
    await ctx.pool.query('UPDATE accounts SET balance = $1::bigint WHERE external_id = $2', [
      (BTC_PRICE * BigInt(CONCURRENCY)).toString(),
      CUSTOMER,
    ]);

    const barrier = new Barrier(CONCURRENCY);
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        placeOrder(ctx.pool, {
          externalId: `drift-${mode}-${String(i)}`,
          cashAccountExternalId: CUSTOMER,
          symbol: 'BTC',
          side: 'buy',
          quantity: parseQuantity('1'),
          mode,
          maxAttempts: 25,
          barrier: () => barrier.arriveAndWait(),
        }),
      ),
    );

    // Only the customer's cash account has an opening balance with no entry
    // behind it; everything else must be exactly explained by its entries.
    const { rows } = await ctx.pool.query<{ external_id: string; drift: bigint }>(
      'SELECT external_id, drift FROM account_derived_balances WHERE drift <> 0',
    );
    expect(rows.map((r) => r.external_id)).toEqual([CUSTOMER]);
  });
});

describe('order constraints are enforced by the database', () => {
  it('rejects a duplicate external id', async () => {
    await buy('dup-1', '0.1');
    await expect(buy('dup-1', '0.1')).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects a non-rejected order with no transaction', async () => {
    await expect(
      ctx.pool.query(
        `INSERT INTO orders (external_id, cash_account_id, asset_account_id, symbol, side,
                             quantity, price, notional, status, transaction_id)
         SELECT 'bad-1', c.id, a.id, 'BTC', 'buy', 1, 1, 1, 'pending', NULL
           FROM accounts c, accounts a
          WHERE c.external_id = $1 AND a.external_id = $2`,
        [CUSTOMER, positionExternalId(CUSTOMER, 'BTC')],
      ),
    ).rejects.toMatchObject({ constraint: 'orders_transaction_matches_status' });
  });

  it('rejects a zero quantity at the database level too', async () => {
    await expect(
      ctx.pool.query(
        `INSERT INTO orders (external_id, cash_account_id, asset_account_id, symbol, side,
                             quantity, price, notional, status, transaction_id)
         SELECT 'bad-2', c.id, a.id, 'BTC', 'buy', 0, 1, 1, 'rejected', NULL
           FROM accounts c, accounts a
          WHERE c.external_id = $1 AND a.external_id = $2`,
        [CUSTOMER, positionExternalId(CUSTOMER, 'BTC')],
      ),
    ).rejects.toMatchObject({ constraint: 'orders_quantity_positive' });
  });
});
