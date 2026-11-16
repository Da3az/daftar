-- The ledger's invariants, enforced by PostgreSQL.
--
-- Hand-written because drizzle-kit cannot emit CREATE TRIGGER or CREATE
-- FUNCTION. The consequence is important and is why these have dedicated tests:
-- `drizzle-kit generate` will never show one of these in a diff and will never
-- detect that one has been dropped or altered. Nothing here is covered by
-- schema drift detection. See apps/api/test/ledger-invariants.test.ts, which
-- asserts each trigger exists in pg_trigger AND that PostgreSQL rejects the
-- write it is supposed to reject.
--
-- Everything below is enforcement, not validation. An application check is
-- advisory: it protects the one code path it sits on. These protect the table.

--------------------------------------------------------------------------------
-- 1. Every transaction balances, and has at least two legs.
--------------------------------------------------------------------------------
--
-- A DEFERRED constraint trigger, so it runs at COMMIT rather than per
-- statement. That is not a performance nicety — it is the only way the check can
-- work at all. Entries are inserted one row at a time, so after the first leg
-- the sum is non-zero by definition. An immediate check would reject every
-- transaction ever written.
--
-- Constraint triggers must be AFTER ... FOR EACH ROW, and cannot use transition
-- relations (REFERENCING NEW TABLE), so the aggregate is recomputed per row
-- rather than once per statement.
--
-- **The cost, stated plainly, because it is inside every Phase 3 number:** a
-- two-leg order pays TWO invocations of this function at commit, each running
-- one indexed aggregate over `entries` for that transaction_id. That is the
-- floor under every latency figure in this repo, and it is why
-- entries_transaction_id_idx is created with the table rather than later.
-- Unindexed it would be two sequential scans of a 10M-row table per order, and
-- the three concurrency strategies would all measure the same scan.

CREATE OR REPLACE FUNCTION ledger_assert_transaction_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  leg_count  bigint;
  net_amount bigint;
BEGIN
  SELECT count(*), coalesce(sum(amount), 0)
    INTO leg_count, net_amount
    FROM entries
   WHERE transaction_id = NEW.transaction_id;

  -- A transaction whose rows were all removed cannot happen (entries are
  -- append-only), but a zero count would mean the aggregate found nothing for a
  -- transaction_id a row was just inserted under, which would be a far stranger
  -- problem than an unbalanced transaction.
  IF leg_count < 2 THEN
    RAISE EXCEPTION
      'ledger transaction % has % leg(s); a double-entry transaction needs at least 2',
      NEW.transaction_id, leg_count
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'entries_transaction_balanced';
  END IF;

  IF net_amount <> 0 THEN
    RAISE EXCEPTION
      'ledger transaction % does not balance: SUM(amount) = %, expected 0',
      NEW.transaction_id, net_amount
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'entries_transaction_balanced';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER entries_transaction_balanced
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION ledger_assert_transaction_balanced();
--> statement-breakpoint

--------------------------------------------------------------------------------
-- 2. Entries are append-only.
--------------------------------------------------------------------------------
--
-- A ledger that can be updated is not a ledger. A correction is a new,
-- opposing transaction (kind = 'adjustment'), which leaves both the error and
-- the correction visible — that is the entire point of the form.
--
-- BEFORE rather than AFTER so the row is never written and no WAL is generated
-- for work that is about to be rejected.

CREATE OR REPLACE FUNCTION ledger_entries_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'entries is append-only: % is not permitted. Correct with a new opposing transaction (kind = ''adjustment'').',
    TG_OP
    USING ERRCODE = 'restrict_violation',
          CONSTRAINT = 'entries_append_only';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER entries_no_update
  BEFORE UPDATE ON entries
  FOR EACH ROW
  EXECUTE FUNCTION ledger_entries_append_only();
--> statement-breakpoint

CREATE TRIGGER entries_no_delete
  BEFORE DELETE ON entries
  FOR EACH ROW
  EXECUTE FUNCTION ledger_entries_append_only();
--> statement-breakpoint

-- TRUNCATE bypasses row-level triggers entirely, so it needs its own statement
-- level one. Without this, `TRUNCATE entries` would silently erase the whole
-- ledger past two triggers that look like they prevent exactly that.
CREATE TRIGGER entries_no_truncate
  BEFORE TRUNCATE ON entries
  FOR EACH STATEMENT
  EXECUTE FUNCTION ledger_entries_append_only();
--> statement-breakpoint

-- Defence in depth, with an honest caveat.
--
-- REVOKE does NOT bind the table owner: an owner always holds every privilege on
-- its own tables, so this has no effect on the role that created `entries`. It
-- matters once the application connects as a non-owner role (Phase 9), and it
-- protects against a privilege accidentally granted to PUBLIC.
--
-- The triggers above are the actual enforcement, and they do apply to the owner
-- and to superusers. The two documented ways around them both require ownership
-- or superuser: `ALTER TABLE entries DISABLE TRIGGER`, and setting
-- `session_replication_role = 'replica'`, which bypasses user triggers. Phase 9
-- runs the app as a role that can do neither.
REVOKE UPDATE, DELETE, TRUNCATE ON entries FROM PUBLIC;
--> statement-breakpoint

--------------------------------------------------------------------------------
-- 3. No appending to an already-committed transaction.
--------------------------------------------------------------------------------
--
-- The invariant that the sum check cannot provide, and the first thing a
-- reviewer with fintech experience asks about.
--
-- `entries_transaction_balanced` is scoped to one transaction_id. So a *later*
-- database transaction that appends a balanced PAIR of entries to an already
-- settled ledger transaction passes it cleanly: the sum is still zero. The books
-- balance, every constraint is satisfied, and history has been rewritten.
--
-- `ledger_transactions.created_xid` holds `pg_current_xact_id()` from the
-- database transaction that opened the row. An entry may only be inserted while
-- that same database transaction is still running. Afterwards, nothing can be
-- added to it — by any code path, including psql.
--
-- Why xid8 and not xid: the 32-bit `xid` wraps, so a persisted value eventually
-- compares equal to an unrelated future transaction. `xid8` carries the epoch
-- and never wraps.

CREATE OR REPLACE FUNCTION ledger_entries_no_late_append()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  opener xid8;
BEGIN
  SELECT created_xid INTO opener
    FROM ledger_transactions
   WHERE id = NEW.transaction_id;

  -- A missing parent is the foreign key's job; it will fire at the end of the
  -- statement. Returning here rather than raising keeps the error the caller
  -- sees as the more specific one.
  IF opener IS NULL THEN
    RETURN NEW;
  END IF;

  IF opener <> pg_current_xact_id() THEN
    RAISE EXCEPTION
      'ledger transaction % was opened by a different, already-finished database transaction; entries cannot be appended to it',
      NEW.transaction_id
      USING ERRCODE = 'restrict_violation',
            CONSTRAINT = 'entries_no_late_append';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER entries_no_late_append
  BEFORE INSERT ON entries
  FOR EACH ROW
  EXECUTE FUNCTION ledger_entries_no_late_append();
--> statement-breakpoint

--------------------------------------------------------------------------------
-- 4. A reusable verification query, as a view.
--------------------------------------------------------------------------------
--
-- The triggers prevent an unbalanced transaction from being committed. This view
-- answers the different question "is the ledger balanced *now*", which is what
-- you want after a bulk load that disabled the triggers (Phase 6), after a
-- restore (Phase 9), or when someone asks you to prove it rather than assert it.
--
-- Empty means balanced. A row means a transaction that does not sum to zero or
-- has fewer than two legs, which should be impossible and is therefore worth
-- being able to check cheaply.

CREATE OR REPLACE VIEW ledger_imbalances AS
SELECT e.transaction_id,
       count(*)    AS leg_count,
       sum(amount) AS net_amount
  FROM entries e
 GROUP BY e.transaction_id
HAVING sum(amount) <> 0 OR count(*) < 2;
