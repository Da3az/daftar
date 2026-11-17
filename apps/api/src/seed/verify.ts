import { createPool } from '../db/pool.ts';
import { env } from '../env.ts';

/**
 * Full-table verification of the ledger's invariants.
 *
 * The seed loads with the write-path triggers disabled, because a deferred
 * constraint trigger cannot survive a 10M-row bulk load — its events queue in
 * per-transaction backend memory. **This is what makes that bypass acceptable:**
 * the triggers prevent a bad write, and this proves no bad write happened.
 * Asserting the invariant over the whole table afterwards is strictly stronger
 * than trusting that the loader was careful.
 *
 * Output is committed as evidence. Exit code is non-zero if anything fails, so
 * it works as a CI gate and as a post-restore check (Phase 9) unchanged.
 */

const pool = createPool({
  connectionString: env.DATABASE_URL,
  max: 1,
  statementTimeoutMs: 0,
  applicationName: 'daftar-verify',
});

interface Check {
  name: string;
  claim: string;
  sql: string;
  /** Passes when the query returns no rows. */
  expectEmpty?: boolean;
}

const CHECKS: Check[] = [
  {
    name: 'every transaction balances, per unit',
    claim: 'SUM(amount) = 0 for every (transaction_id, unit)',
    sql: 'SELECT * FROM ledger_imbalances LIMIT 20',
    expectEmpty: true,
  },
  {
    name: 'every unit nets to zero system-wide',
    claim: 'money does not appear or vanish; it only moves',
    sql: 'SELECT * FROM ledger_totals_by_unit WHERE net_amount <> 0',
    expectEmpty: true,
  },
  {
    name: 'no transaction has fewer than two legs',
    claim: 'a single-legged transaction is not double entry',
    sql: `SELECT transaction_id, count(*) AS legs
            FROM entries GROUP BY transaction_id HAVING count(*) < 2 LIMIT 20`,
    expectEmpty: true,
  },
  {
    name: 'no zero-amount entries',
    claim: 'entries_amount_nonzero held through the bulk load',
    sql: 'SELECT id FROM entries WHERE amount = 0 LIMIT 20',
    expectEmpty: true,
  },
  {
    name: 'direction agrees with the sign of amount',
    claim: 'entries_direction_matches_sign held through the bulk load',
    sql: `SELECT id, amount, direction FROM entries
           WHERE (direction = 'debit') <> (amount < 0) LIMIT 20`,
    expectEmpty: true,
  },
  {
    name: "every entry's unit matches its account's unit",
    claim: 'entries_account_unit_fk held through the bulk load',
    sql: `SELECT e.id, e.unit, a.unit AS account_unit
            FROM entries e JOIN accounts a ON a.id = e.account_id
           WHERE e.unit <> a.unit LIMIT 20`,
    expectEmpty: true,
  },
  {
    name: 'no entry references a missing account or transaction',
    claim: 'the foreign keys held through the bulk load',
    sql: `SELECT e.id FROM entries e
            LEFT JOIN accounts a ON a.id = e.account_id
            LEFT JOIN ledger_transactions t ON t.id = e.transaction_id
           WHERE a.id IS NULL OR t.id IS NULL LIMIT 20`,
    expectEmpty: true,
  },
];

/**
 * Render a row for the failure report.
 *
 * Needs its own function because `JSON.stringify` throws on a bigint, and every
 * amount in this schema is one — a replacer inline in the template literal
 * returns `any`, which is exactly the kind of untyped hole the lint rules exist
 * to catch.
 */
function describeRow(row: unknown): string {
  if (row === null || typeof row !== 'object') return String(row);

  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    flat[key] = typeof value === 'bigint' ? value.toString() : String(value);
  }
  return JSON.stringify(flat);
}

let failures = 0;

try {
  const { rows: counts } = await pool.query<{
    entries: bigint;
    transactions: bigint;
    accounts: bigint;
  }>(
    `SELECT (SELECT count(*) FROM entries)             AS entries,
            (SELECT count(*) FROM ledger_transactions) AS transactions,
            (SELECT count(*) FROM accounts)            AS accounts`,
  );

  const { rows: version } = await pool.query<{ v: string }>('SELECT version() AS v');

  process.stdout.write(`PostgreSQL: ${version[0]?.v ?? 'unknown'}\n`);
  process.stdout.write(`Dataset:    entries=${String(counts[0]?.entries)} `);
  process.stdout.write(`transactions=${String(counts[0]?.transactions)} `);
  process.stdout.write(`accounts=${String(counts[0]?.accounts)}\n\n`);

  for (const check of CHECKS) {
    const started = performance.now();
    const { rows } = await pool.query(check.sql);
    const ms = Math.round(performance.now() - started);

    const ok = check.expectEmpty ? rows.length === 0 : rows.length > 0;
    if (!ok) failures += 1;

    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${check.name}  (${String(ms)}ms)\n`);
    process.stdout.write(`      ${check.claim}\n`);
    if (!ok) {
      process.stdout.write(`      offending rows (up to 20):\n`);
      for (const row of rows) {
        process.stdout.write(`        ${describeRow(row)}\n`);
      }
    }
  }

  /**
   * Reported, not asserted. Drift is EXPECTED here and saying so matters: the
   * seed funds customer cash accounts directly, so those balances have no
   * entries behind them by design. A check that failed on drift would have to be
   * disabled, and a disabled check is worse than an honest one.
   */
  const { rows: drift } = await pool.query<{ n: bigint; total: bigint }>(
    `SELECT count(*) AS n, coalesce(sum(abs(drift)), 0)::bigint AS total
       FROM account_derived_balances WHERE drift <> 0`,
  );

  process.stdout.write(
    `\nINFO  accounts whose stored balance has no matching entries: ${String(drift[0]?.n)} ` +
      `(total ${String(drift[0]?.total)} minor units)\n`,
  );
  process.stdout.write(
    `      Expected: the seed funds customer cash directly rather than through\n` +
      `      funding transactions. Every account touched BY a transaction is\n` +
      `      covered by the checks above.\n`,
  );

  process.stdout.write(
    `\n${failures === 0 ? 'ALL CHECKS PASSED' : `${String(failures)} CHECK(S) FAILED`}\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await pool.end();
}
