import type pg from 'pg';

/**
 * Truncate every mutable table, in dependency order.
 *
 * ## Why this is one shared function
 *
 * Each test file used to spell its own cleanup out, and adding a table broke
 * them one at a time — three times. `outbox` was the last: it has a foreign key
 * to `ledger_transactions`, so every fixture that did
 * `DELETE FROM ledger_transactions` started failing with 23503, and the symptom
 * appeared in the *idempotency* suite, which has nothing to do with the outbox.
 *
 * A new table now needs one line here rather than an edit in every test file,
 * and forgetting it fails loudly in one place.
 *
 * ## Why DELETE and not TRUNCATE
 *
 * `entries` has a `BEFORE TRUNCATE` trigger that rejects it — deliberately, so
 * one statement cannot erase the ledger past the row-level guards. The tests do
 * not get an exemption from that; they disable the delete trigger for exactly
 * the two statements that need it and re-enable it immediately.
 *
 * Disabling a trigger is legitimate here and nowhere else: each test file owns a
 * private cloned database, so there is nothing else to affect.
 */
export async function resetLedger(pool: pg.Pool): Promise<void> {
  // Children before parents.
  await pool.query('DELETE FROM trades');
  await pool.query('DELETE FROM book_orders');
  await pool.query('DELETE FROM participants');
  await pool.query('DELETE FROM outbox');
  await pool.query('DELETE FROM idempotency_keys');
  await pool.query('DELETE FROM webhook_events');
  await pool.query('DELETE FROM orders');

  await pool.query('ALTER TABLE entries DISABLE TRIGGER entries_no_delete');
  try {
    await pool.query('DELETE FROM entries');
  } finally {
    // In a finally block so a failure cannot leave the guard off for the rest
    // of the file's tests — which would make an append-only assertion pass for
    // the wrong reason.
    await pool.query('ALTER TABLE entries ENABLE TRIGGER entries_no_delete');
  }

  await pool.query('DELETE FROM ledger_transactions');
  await pool.query('DELETE FROM accounts');
}

/**
 * Reset the reference prices too.
 *
 * `instruments` is reference data seeded by migration 0005, and tests mutate it
 * — one deliberately doubles the BTC price to prove a frozen order price does
 * not follow the market. Without resetting it, every later test in that file
 * priced its orders at 2x and funded accounts came up short, which presented as
 * a failure in a *concurrency* test.
 */
export async function resetInstruments(pool: pg.Pool): Promise<void> {
  await pool.query(
    `UPDATE instruments SET reference_price = v.price
       FROM (VALUES ('BTC', 9543217::bigint), ('ETH', 318442::bigint), ('ARB', 87::bigint))
            AS v(symbol, price)
      WHERE instruments.symbol = v.symbol`,
  );
}
