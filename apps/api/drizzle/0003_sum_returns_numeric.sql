-- Fix: `sum(bigint)` returns `numeric`, not `bigint`.
--
-- This is the same class of bug as the one `db/bigint.ts` exists to prevent, in
-- a place the type parser cannot reach.
--
-- PostgreSQL's `sum()` over a `bigint` column is declared to return `numeric`,
-- because summing many int8 values can exceed int8. Verified:
--
--   SELECT pg_typeof(sum(amount)) FROM (SELECT 1::bigint AS amount) s;  -- numeric
--   SELECT pg_typeof(count(*))    FROM (SELECT 1::bigint AS amount) s;  -- bigint
--
-- `numeric` has unbounded precision, so there is no lossless JavaScript
-- primitive for it and the driver deliberately returns it as a **string**. The
-- result is that `SELECT sum(amount) ...` hands the application `"0"` where
-- every other amount in the system is a `bigint` — and `sum + other` then
-- concatenates instead of adding. Exactly the `"100" + "50" === "10050"` failure
-- this project opens by ruling out, reintroduced through an aggregate.
--
-- `ledger_imbalances` was caught by a test asserting `net_amount` was `0n` and
-- receiving `'0'`. Casting in SQL is the fix, rather than parsing in the
-- application: it keeps the boundary rule ("an amount leaving the database is a
-- bigint") true without exception.
--
-- The cast narrows, so it can raise 22003 (numeric_value_out_of_range) if a
-- ledger's net total ever exceeds int8. That is the correct behaviour: a loud
-- error beats a silently wrapped balance, and an amount that cannot fit in the
-- column type it came from is a real problem rather than a formatting one.
--
-- CREATE OR REPLACE VIEW cannot change a column's type, so the view is dropped
-- and recreated. Written as a new migration rather than an edit to 0002: an
-- applied migration is history, and rewriting it would invalidate the journal
-- hash for anyone who had already run it.

DROP VIEW IF EXISTS ledger_imbalances;
--> statement-breakpoint

CREATE VIEW ledger_imbalances AS
SELECT e.transaction_id,
       count(*)              AS leg_count,
       sum(e.amount)::bigint AS net_amount
  FROM entries e
 GROUP BY e.transaction_id
HAVING sum(e.amount) <> 0 OR count(*) < 2;
--> statement-breakpoint

-- A balance derived from entries, for the verification query Phase 6 commits as
-- evidence and for anything that needs to prove the stored snapshot in
-- `accounts.balance` agrees with the entries behind it.
--
-- Note what this view is NOT: it is not the read path for a sufficient-funds
-- check. That is an aggregate over an account's whole history, and routing the
-- Phase 3 benchmark through it would mean measuring how three concurrency
-- strategies serialise an aggregate scan rather than measuring the locks. The
-- stored snapshot exists for that reason; this view exists to prove the snapshot
-- is honest.
CREATE VIEW account_derived_balances AS
SELECT a.id                                  AS account_id,
       a.external_id,
       a.balance                              AS stored_balance,
       coalesce(sum(e.amount), 0)::bigint     AS derived_balance,
       a.balance - coalesce(sum(e.amount), 0)::bigint AS drift,
       count(e.id)                            AS entry_count
  FROM accounts a
  LEFT JOIN entries e ON e.account_id = a.id
 GROUP BY a.id, a.external_id, a.balance;
