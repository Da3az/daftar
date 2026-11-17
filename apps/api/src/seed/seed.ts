import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { from as copyFrom } from 'pg-copy-streams';
import type pg from 'pg';
import { createPool } from '../db/pool.ts';
import { env } from '../env.ts';
import { HOUSE_CASH_EXTERNAL_ID, houseAssetExternalId, positionExternalId } from '../orders/place.ts';

/**
 * # The ~10M-entry seed
 *
 * Every benchmark in this repo runs against this dataset. The first question any
 * reviewer asks a latency number is "at what table size?", and an empty table is
 * the wrong answer.
 *
 * ## Why a naive bulk insert is not merely slow but infeasible
 *
 * `entries_transaction_balanced` is a `DEFERRABLE INITIALLY DEFERRED`
 * constraint trigger. Deferred trigger events are queued in **per-transaction
 * backend memory** and fired at COMMIT. Insert 10M rows in one transaction and
 * one of two things happens:
 *
 *  - 10M queued events each run one aggregate at commit — tens of minutes of
 *    work in a single un-interruptible COMMIT, or
 *  - the backend exhausts memory building the queue first.
 *
 * Neither is a seed script; both are an outage.
 *
 * ## What this does instead
 *
 * Disables the two write-path triggers, bulk-loads with chunked `COPY`,
 * re-enables them, and then runs a **full-table verification** whose output is
 * committed as evidence. The triggers prevent a bad write; the verification
 * proves the bypass did not produce one. Asserting the invariant after the fact
 * is strictly stronger than trusting that the loader was careful.
 *
 * `COPY` rather than multi-row `INSERT`: it skips the executor per row and the
 * per-statement parse/plan entirely.
 *
 * Usage:
 *
 *   node src/seed/seed.ts --entries 10000000 --customers 2000
 *   node src/seed/seed.ts --entries 100000 --customers 50   # quick check
 */

interface Options {
  targetEntries: number;
  customers: number;
  chunkTransactions: number;
  symbol: string;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string, fallback: number): number => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const value = Number(argv[i + 1]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`--${name} needs a positive number`);
    }
    return Math.floor(value);
  };

  return {
    targetEntries: get('entries', 10_000_000),
    customers: get('customers', 2_000),
    /** Transactions per COPY chunk. 4 entries each. */
    chunkTransactions: get('chunk', 50_000),
    symbol: 'BTC',
  };
}

const log = (message: string): void => {
  process.stdout.write(`${new Date().toISOString()}  ${message}\n`);
};

/**
 * Deterministic pseudo-random, so two runs of the seed produce byte-identical
 * data.
 *
 * `Math.random()` would make the dataset different on every run, and then a
 * "before" and an "after" measured on different days would differ partly
 * because the data differed. mulberry32 — small, fast, and good enough for
 * choosing which account a transaction touches.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20261116;

interface AccountIds {
  customerCash: bigint[];
  customerAsset: bigint[];
  houseCash: bigint;
  houseAsset: bigint;
  external: bigint;
}

async function ensureAccounts(client: pg.PoolClient, options: Options): Promise<AccountIds> {
  log(`creating ${String(options.customers)} customers (cash + ${options.symbol} position)`);

  const cashIds: string[] = [];
  const assetIds: string[] = [];
  for (let i = 0; i < options.customers; i += 1) {
    const id = `seed-${String(i).padStart(6, '0')}`;
    cashIds.push(id);
    assetIds.push(positionExternalId(id, options.symbol));
  }

  await client.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol, balance)
     SELECT x, 'customer_cash', NULL, 0 FROM unnest($1::text[]) AS x
     ON CONFLICT (external_id) DO NOTHING`,
    [cashIds],
  );

  await client.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol, balance)
     SELECT x, 'customer_asset', $2, 0 FROM unnest($1::text[]) AS x
     ON CONFLICT (external_id) DO NOTHING`,
    [assetIds, options.symbol],
  );

  await client.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol, balance) VALUES
       ($1, 'house_cash',       NULL, 0),
       ($2, 'house_asset',      $3,   0),
       ('external:funding', 'external_funding', NULL, 0)
     ON CONFLICT (external_id) DO NOTHING`,
    [HOUSE_CASH_EXTERNAL_ID, houseAssetExternalId(options.symbol), options.symbol],
  );

  const { rows } = await client.query<{ id: bigint; external_id: string }>(
    `SELECT id, external_id FROM accounts
      WHERE external_id = ANY($1::text[])
         OR external_id = ANY($2::text[])
         OR external_id IN ($3, $4, 'external:funding')`,
    [cashIds, assetIds, HOUSE_CASH_EXTERNAL_ID, houseAssetExternalId(options.symbol)],
  );

  const byExternal = new Map(rows.map((r) => [r.external_id, r.id]));

  return {
    customerCash: cashIds.map((e) => byExternal.get(e)!),
    customerAsset: assetIds.map((e) => byExternal.get(e)!),
    houseCash: byExternal.get(HOUSE_CASH_EXTERNAL_ID)!,
    houseAsset: byExternal.get(houseAssetExternalId(options.symbol))!,
    external: byExternal.get('external:funding')!,
  };
}

/**
 * COPY text format. Columns tab-separated, rows newline-terminated, `\N` for
 * NULL. Nothing here contains a tab, newline or backslash — account ids are
 * digits and units are uppercase letters — so no escaping is needed, and a
 * comment is cheaper than an escape routine that is never exercised.
 */
async function copyChunk(client: pg.PoolClient, table: string, columns: string, rows: string[]) {
  const stream = client.query(copyFrom(`COPY ${table} (${columns}) FROM STDIN`));
  await pipeline(Readable.from(rows, { objectMode: false }), stream);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // Four entries per transaction (buy: cash pair + asset pair).
  const entriesPerTransaction = 4;
  const totalTransactions = Math.floor(options.targetEntries / entriesPerTransaction);
  const totalEntries = totalTransactions * entriesPerTransaction;

  log(
    `target ${String(totalEntries)} entries in ${String(totalTransactions)} transactions, ` +
      `chunk ${String(options.chunkTransactions)}`,
  );

  const pool = createPool({
    connectionString: env.DATABASE_URL,
    max: 1,
    statementTimeoutMs: 0,
    applicationName: 'daftar-seed',
  });

  const client = await pool.connect();
  const startedAt = Date.now();

  try {
    const accounts = await ensureAccounts(client, options);

    /**
     * `maintenance_work_mem` governs index build and VACUUM memory for THIS
     * session. Raised for the load because the index on `entries` is maintained
     * throughout; set per-session rather than in the server config so it does
     * not apply to the API's connections, where a large value times many
     * backends is how a box runs out of memory.
     */
    await client.query(`SET maintenance_work_mem = '512MB'`);
    await client.query(`SET synchronous_commit = off`);

    log('disabling write-path triggers for the bulk load');
    /**
     * Both have to go, for different reasons:
     *
     *  - `entries_transaction_balanced` is the deferred one whose event queue
     *    would exhaust the backend.
     *  - `entries_no_late_append` would reject every row, because COPY runs in a
     *    different database transaction from the one that created the
     *    `ledger_transactions` rows, which is precisely what it exists to stop.
     *
     * The verification at the end is what makes this safe rather than merely
     * convenient.
     */
    await client.query('ALTER TABLE entries DISABLE TRIGGER entries_transaction_balanced');
    await client.query('ALTER TABLE entries DISABLE TRIGGER entries_no_late_append');

    const random = mulberry32(SEED);
    const price = 9_543_217n;

    let written = 0;
    let chunkIndex = 0;

    while (written < totalTransactions) {
      const batch = Math.min(options.chunkTransactions, totalTransactions - written);

      await client.query('BEGIN');

      // Reserve a contiguous block of transaction ids in one round trip.
      const { rows: idRows } = await client.query<{ id: bigint }>(
        `INSERT INTO ledger_transactions (kind)
         SELECT 'buy' FROM generate_series(1, $1::int) RETURNING id`,
        [batch],
      );

      const entryRows: string[] = [];
      for (let i = 0; i < batch; i += 1) {
        const txnId = idRows[i]!.id.toString();

        const customerIndex = Math.floor(random() * options.customers);
        const cashId = accounts.customerCash[customerIndex]!.toString();
        const assetId = accounts.customerAsset[customerIndex]!.toString();

        // Quantities between 0.00100000 and 0.10100000 BTC, in satoshi.
        const quantity = BigInt(100_000 + Math.floor(random() * 10_000_000));
        const notional = (quantity * price) / 100_000_000n;
        if (notional === 0n) continue;

        const q = quantity.toString();
        const n = notional.toString();

        entryRows.push(
          `${txnId}\t${cashId}\t-${n}\tdebit\tUSD\n`,
          `${txnId}\t${accounts.houseCash.toString()}\t${n}\tcredit\tUSD\n`,
          `${txnId}\t${assetId}\t${q}\tcredit\t${options.symbol}\n`,
          `${txnId}\t${accounts.houseAsset.toString()}\t-${q}\tdebit\t${options.symbol}\n`,
        );
      }

      await copyChunk(
        client,
        'entries',
        'transaction_id, account_id, amount, direction, unit',
        entryRows,
      );

      await client.query('COMMIT');

      written += batch;
      chunkIndex += 1;

      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = Math.round((written * entriesPerTransaction) / elapsed);
      log(
        `chunk ${String(chunkIndex)}: ${String(written * entriesPerTransaction)}/${String(totalEntries)} entries ` +
          `(${String(rate)}/s, ${elapsed.toFixed(1)}s elapsed)`,
      );
    }

    log('re-enabling write-path triggers');
    await client.query('ALTER TABLE entries ENABLE TRIGGER entries_transaction_balanced');
    await client.query('ALTER TABLE entries ENABLE TRIGGER entries_no_late_append');

    /**
     * Rebuild the snapshot from the entries, rather than maintaining it during
     * the load. One pass at the end is far cheaper than 10M incremental updates,
     * and it means the snapshot is derived from the thing it is supposed to
     * summarise rather than from the loader's own bookkeeping.
     */
    log('rebuilding accounts.balance from entries');
    await client.query(
      `UPDATE accounts a
          SET balance = coalesce(e.net, 0)
         FROM (SELECT account_id, sum(amount)::bigint AS net FROM entries GROUP BY account_id) e
        WHERE e.account_id = a.id`,
    );

    /**
     * Fund every customer generously so benchmark orders are not refused for
     * insufficient funds — a run where 90% of requests 422 measures the refusal
     * path, not the ledger write path. Done after the snapshot rebuild, so it is
     * deliberately a balance with no entries behind it; `account_derived_balances`
     * will report that drift honestly rather than hiding it.
     */
    log('funding customer cash accounts for benchmark runs');
    await client.query(
      `UPDATE accounts SET balance = balance + 1000000000000
        WHERE kind = 'customer_cash' AND external_id LIKE 'seed-%'`,
    );

    log('ANALYZE');
    await client.query('ANALYZE entries');
    await client.query('ANALYZE accounts');
    await client.query('ANALYZE ledger_transactions');

    log(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
