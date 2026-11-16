-- Entries carry a unit, and transactions balance **per unit**.
--
-- ## The problem this fixes
--
-- A buy moves two different things at once: cash out of the customer and asset
-- quantity in. Modelled as four legs in one transaction, with a single
-- `SUM(amount) = 0` check across all of them, the arithmetic is:
--
--     -notional + notional + quantity - quantity = 0
--
-- which sums to zero — and is meaningless. It adds cents to satoshis. The check
-- would pass just as happily if a cash leg were wrong by exactly the amount an
-- asset leg was wrong by in the other direction. A ledger that balances by
-- adding dollars to bitcoin is not balanced; it is unaudited.
--
-- ## The fix
--
-- `entries.unit` names what the amount is denominated in — 'USD' for cash,
-- 'BTC'/'ETH'/... for an asset. The balance check groups by it: **every unit in
-- a transaction must independently sum to zero.** A buy is then two balanced
-- pairs inside one atomic transaction, which is what it actually is.
--
-- This is not FX. There is still exactly one currency and no conversion: an
-- asset quantity is a different *commodity*, not a different currency, and no
-- rate is ever applied between two units inside the ledger. The price that links
-- them is frozen into the order and appears only as the cash leg's amount.
--
-- ## Why the unit cannot disagree with the account
--
-- An entry denominated in BTC against a cash account would be nonsense that the
-- per-unit sum would not catch — both BTC legs could balance each other while
-- sitting on the wrong accounts. So the pairing is enforced structurally, by a
-- composite foreign key rather than by a trigger:
--
--     accounts  UNIQUE (id, unit)
--     entries   FOREIGN KEY (account_id, unit) REFERENCES accounts (id, unit)
--
-- `accounts.unit` is a GENERATED column derived from the existing
-- `asset_symbol`, so it cannot drift from it and there is no second place to
-- keep in sync. The foreign key then makes a mismatched unit unrepresentable —
-- not merely rejected, but impossible to express.

ALTER TABLE accounts
  ADD COLUMN unit text
  GENERATED ALWAYS AS (coalesce(asset_symbol, 'USD')) STORED;
--> statement-breakpoint

-- Required as the target of the composite foreign key below. Redundant with the
-- primary key on `id` alone, and that is fine: it exists to be referenced.
ALTER TABLE accounts
  ADD CONSTRAINT accounts_id_unit_key UNIQUE (id, unit);
--> statement-breakpoint

-- Backfilled from the account rather than defaulted to 'USD', so existing rows
-- get the right answer instead of a plausible one. NOT NULL is applied after the
-- backfill, which is also the pattern a zero-downtime deploy would need.
ALTER TABLE entries ADD COLUMN unit text;
--> statement-breakpoint

UPDATE entries e SET unit = a.unit FROM accounts a WHERE a.id = e.account_id;
--> statement-breakpoint

ALTER TABLE entries ALTER COLUMN unit SET NOT NULL;
--> statement-breakpoint

ALTER TABLE entries
  ADD CONSTRAINT entries_account_unit_fk
  FOREIGN KEY (account_id, unit) REFERENCES accounts (id, unit);
--> statement-breakpoint

--------------------------------------------------------------------------------
-- The balance check, now per unit.
--------------------------------------------------------------------------------
--
-- Same deferred constraint trigger, same two-invocations-per-two-leg-order cost.
-- The aggregate now groups by unit, so a four-leg buy is checked as two
-- independent balanced pairs.
--
-- Still at least two legs overall. Not "at least two legs per unit": a
-- single-unit transaction is the common case and already needs two, and
-- requiring two per unit would forbid a legitimate three-leg transaction that
-- splits one side across two accounts in the same unit... which has two legs in
-- that unit anyway. The rule that actually matters — nothing can move without a
-- counterpart in the same unit — is exactly what per-unit SUM = 0 says.

CREATE OR REPLACE FUNCTION ledger_assert_transaction_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  leg_count    bigint;
  bad_unit     text;
  bad_net      bigint;
BEGIN
  SELECT count(*) INTO leg_count
    FROM entries
   WHERE transaction_id = NEW.transaction_id;

  IF leg_count < 2 THEN
    RAISE EXCEPTION
      'ledger transaction % has % leg(s); a double-entry transaction needs at least 2',
      NEW.transaction_id, leg_count
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'entries_transaction_balanced';
  END IF;

  SELECT e.unit, sum(e.amount)::bigint
    INTO bad_unit, bad_net
    FROM entries e
   WHERE e.transaction_id = NEW.transaction_id
   GROUP BY e.unit
  HAVING sum(e.amount) <> 0
   LIMIT 1;

  IF bad_unit IS NOT NULL THEN
    RAISE EXCEPTION
      'ledger transaction % does not balance in %: SUM(amount) = %, expected 0',
      NEW.transaction_id, bad_unit, bad_net
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'entries_transaction_balanced';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

--------------------------------------------------------------------------------
-- The verification views, now per unit.
--------------------------------------------------------------------------------

DROP VIEW IF EXISTS ledger_imbalances;
--> statement-breakpoint

CREATE VIEW ledger_imbalances AS
SELECT e.transaction_id,
       e.unit,
       count(*)              AS leg_count,
       sum(e.amount)::bigint AS net_amount
  FROM entries e
 GROUP BY e.transaction_id, e.unit
HAVING sum(e.amount) <> 0;
--> statement-breakpoint

DROP VIEW IF EXISTS account_derived_balances;
--> statement-breakpoint

CREATE VIEW account_derived_balances AS
SELECT a.id                                           AS account_id,
       a.external_id,
       a.unit,
       a.balance                                      AS stored_balance,
       coalesce(sum(e.amount), 0)::bigint             AS derived_balance,
       a.balance - coalesce(sum(e.amount), 0)::bigint AS drift,
       count(e.id)                                    AS entry_count
  FROM accounts a
  LEFT JOIN entries e ON e.account_id = a.id
 GROUP BY a.id, a.external_id, a.unit, a.balance;
--> statement-breakpoint

-- A ledger-wide invariant worth being able to state in one query: across the
-- whole system, every unit nets to zero. Money does not appear or vanish; it
-- only moves between accounts, and `external_funding` is negative by exactly
-- what has entered.
CREATE VIEW ledger_totals_by_unit AS
SELECT unit,
       count(*)            AS entry_count,
       sum(amount)::bigint AS net_amount
  FROM entries
 GROUP BY unit;
