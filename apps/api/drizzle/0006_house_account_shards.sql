-- Shard the house counterparty accounts.
--
-- ## The measurement that forced this
--
-- Phase 3's first benchmark run, against the 10M-row seed at 50 VUs:
--
--   strategy       spread 1    spread 10   spread 1000
--   pessimistic    209 ord/s   199 ord/s   209 ord/s
--   advisory       180 ord/s   185 ord/s   198 ord/s
--   serializable    88% of requests failed with SQLSTATE 40001
--
-- **The account spread made no difference at all.** That is not what the SLO
-- premise assumed, and the reason is in the schema rather than in any of the
-- three strategies.
--
-- Every order is four legs: customer cash, customer position, house cash, house
-- position. The customer side spreads across 1000 accounts. The house side is
-- *two rows*, touched by every order ever placed:
--
--   external_id      kind            entry_count
--   house:USD        house_cash          2543857
--   house:BTC        house_asset         2543857
--   seed-000000      customer_cash         17261
--
-- So:
--
--  - `pessimistic` and `advisory` take a lock on the house row in every
--    transaction. Throughput is bounded by lock hold time on one row, which is
--    why all six of their numbers sit near 200/s no matter how the customers
--    spread. The CPU was not saturated and the pool was not exhausted.
--  - `serializable` conflicts on the house row in essentially every
--    transaction. 63,784 serialization failures, five attempts each, and most
--    orders never landed.
--
-- A spread parameter that spreads only three quarters of each transaction does
-- not spread the transaction.
--
-- ## The fix
--
-- `house:USD` becomes `house:USD:00` … `house:USD:0F`, and likewise for each
-- asset. 16 shards. A given customer always maps to the same shard
-- (`cash_account_id % 16`), which matters for two reasons:
--
--  1. **Per-account ordering is preserved.** A customer's orders always touch
--     the same house rows in the same order, so there is no new interleaving.
--  2. **The lock order stays total.** `post()` sorts account ids before
--     acquiring, so adding shards does not create a cycle.
--
-- This is the standard sharded-counter mitigation, applied to an omnibus
-- account. It does not weaken any invariant: each transaction still balances
-- per unit, and the house's true position is `SUM` across its shards — which the
-- `house_positions` view below states once so nothing has to remember to add
-- them up.
--
-- 16 and not 64: the house side should stop being the bottleneck, not become a
-- table of mostly-idle rows. 16 takes the house's share of contention below the
-- customer side's at spread=1000, which is the point where the spread parameter
-- starts meaning something. Phase 3's re-run reports whether that held.

-- The shard accounts. `generate_series` rather than 32 literal rows so the
-- shard count appears exactly once.
INSERT INTO accounts (external_id, kind, asset_symbol, balance)
SELECT 'house:USD:' || lpad(to_hex(n), 2, '0'), 'house_cash', NULL, 0
  FROM generate_series(0, 15) AS n
ON CONFLICT (external_id) DO NOTHING;
--> statement-breakpoint

INSERT INTO accounts (external_id, kind, asset_symbol, balance)
SELECT 'house:' || i.symbol || ':' || lpad(to_hex(n), 2, '0'),
       'house_asset',
       i.symbol,
       0
  FROM instruments i, generate_series(0, 15) AS n
ON CONFLICT (external_id) DO NOTHING;
--> statement-breakpoint

-- The house's real position, per unit, across every shard.
--
-- Exists so that "what does the house hold" is one query rather than a join
-- someone has to remember to write. A sharded balance that can only be read
-- correctly by code that knows about the sharding is a trap.
CREATE OR REPLACE VIEW house_positions AS
SELECT a.unit,
       count(*)                 AS shard_count,
       sum(a.balance)::bigint   AS stored_balance,
       min(a.balance)           AS min_shard_balance,
       max(a.balance)           AS max_shard_balance
  FROM accounts a
 WHERE a.kind IN ('house_cash', 'house_asset')
 GROUP BY a.unit;
