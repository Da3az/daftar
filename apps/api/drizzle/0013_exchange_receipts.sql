-- What the exchange's receipts need: the ledger transaction behind each feed
-- row, the balance a movement left, and guest names that say nothing about the
-- session.
--
-- Hand-written, like 0006–0012: nothing here is in `schema.ts`.

--------------------------------------------------------------------------------
-- The feed row's ledger transaction
--------------------------------------------------------------------------------
--
-- A feed row is published from an outbox row, and the outbox row knows its
-- ledger transaction — but published outbox rows are reaped after a day, so the
-- link has to be copied while it still exists. From here on the publisher
-- copies it. Rows older than the outbox's retention cannot be linked and stay
-- NULL: the API answers those with no ledger lines rather than guessing.
--
-- No foreign key, for the same reason `outbox_event_id` has none: this is a
-- read model, and it must never be what blocks a ledger maintenance job.
ALTER TABLE exchange_activity ADD COLUMN transaction_id bigint;
--> statement-breakpoint
UPDATE exchange_activity a
   SET transaction_id = o.transaction_id
  FROM outbox o
 WHERE o.id = a.outbox_event_id
   AND a.transaction_id IS NULL;
--> statement-breakpoint

--------------------------------------------------------------------------------
-- The balance a withdrawal or transfer left
--------------------------------------------------------------------------------
--
-- So a retry with the same client id can be answered with the original result,
-- figures included, instead of being re-checked against today's balance. NULL
-- for movements made before this column existed.
ALTER TABLE cash_movements ADD COLUMN balance_after bigint;
--> statement-breakpoint

--------------------------------------------------------------------------------
-- Guest names independent of the session subject
--------------------------------------------------------------------------------
--
-- "Guest 1A2B" used to be the last four hex digits of `external_id`, which is
-- the session's subject. Every trade now names its counterparty, so the name is
-- shown to strangers, and it must not carry any bits of a secret. Existing
-- guests get a fresh random name; new ones are named the same way at creation.
UPDATE participants
   SET display_name = 'Guest ' || upper(substr(md5(gen_random_uuid()::text), 1, 4))
 WHERE kind = 'guest';
