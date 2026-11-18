-- Fix: `webhook_payload_conflicts` could never return a row.
--
-- Migration 0007 defined it as
--
--   SELECT provider, idempotency_key, count(DISTINCT payload_hash)
--     FROM webhook_events GROUP BY provider, idempotency_key
--   HAVING count(DISTINCT payload_hash) > 1
--
-- which assumes two rows can exist for one key carrying different payload
-- hashes. They cannot: `UNIQUE (provider, idempotency_key)` allows exactly one
-- row per key, and the route *rejects* a conflicting payload rather than storing
-- it. So the view was structurally incapable of firing — a dead query wearing
-- the costume of a safety net, which is worse than no check at all because
-- someone would look at it, see zero rows, and conclude the system was clean.
--
-- Caught by exercising the real surface: `sign-webhook.mjs conflict` correctly
-- produced a 409 and an error log, and the view still returned nothing.
--
-- The rejection is the right behaviour and does not change. What changes is that
-- the *event* of a conflicting delivery is now recorded on the surviving row, so
-- it is visible in the Settlements UI and countable in a query.

ALTER TABLE webhook_events
  ADD COLUMN payload_conflict_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE webhook_events
  ADD COLUMN last_conflicting_hash text;
--> statement-breakpoint

ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_conflict_count_non_negative
  CHECK (payload_conflict_count >= 0);
--> statement-breakpoint

-- A conflicting hash is only meaningful if a conflict was actually seen.
ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_conflict_hash_implies_count
  CHECK ((last_conflicting_hash IS NULL) OR (payload_conflict_count > 0));
--> statement-breakpoint

DROP VIEW IF EXISTS webhook_payload_conflicts;
--> statement-breakpoint

-- Now capable of returning rows, which is the entire point.
--
-- A row here means a provider delivered two different bodies under one event id,
-- or someone replayed a modified payload. Either is worth a page. Empty is the
-- healthy state, and now it is a meaningful empty.
CREATE VIEW webhook_payload_conflicts AS
SELECT provider,
       idempotency_key,
       object_id,
       event_type,
       payload_hash           AS accepted_hash,
       last_conflicting_hash  AS rejected_hash,
       payload_conflict_count AS conflicts,
       delivery_count,
       received_at
  FROM webhook_events
 WHERE payload_conflict_count > 0;
