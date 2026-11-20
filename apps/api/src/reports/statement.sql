-- The account statement with a running balance.
--
-- Phase 6's slow query. Kept as a file so the EXPLAIN in
-- docs/evidence/06-query-performance.md is reproducible verbatim.
--
-- ## ORDER BY (created_at, id), never created_at alone
--
-- A window function's frame is defined by its ORDER BY. If two entries share a
-- `created_at` — and they will, because a four-leg order writes all four in one
-- statement with one `now()` — then `ORDER BY created_at` leaves their relative
-- order unspecified, and PostgreSQL is free to return them differently between
-- runs or after a plan change.
--
-- For a running balance that is a **correctness** bug, not a cosmetic one: the
-- intermediate values differ, so two readers of the same statement disagree
-- about what the balance was at a given row. Adding `id` makes the order total,
-- because `id` is unique.
--
-- This is also why timestamps are kept as exact strings rather than parsed into
-- a millisecond-precision JavaScript Date: truncating microseconds would
-- *manufacture* ties that the data does not contain, and the `id` tiebreaker
-- would then be doing work it should not have to.

SELECT
  e.id,
  e.created_at,
  e.transaction_id,
  t.kind                AS transaction_kind,
  e.direction,
  e.unit,
  e.amount,
  sum(e.amount) OVER (
    ORDER BY e.created_at, e.id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )::bigint             AS running_balance
FROM entries e
JOIN ledger_transactions t ON t.id = e.transaction_id
WHERE e.account_id = $1::bigint
ORDER BY e.created_at, e.id
LIMIT $2::int;
