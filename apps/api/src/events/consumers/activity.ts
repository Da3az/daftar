import type pg from 'pg';
import type { Envelope } from '../envelope.ts';

/**
 * # The activity feed, as a consumer of the event log
 *
 * The same table and the same dedup key as the direct publisher in
 * `outbox/runner.ts` — `UNIQUE (outbox_event_id)` — with one difference that
 * matters: the row is built from the **message**, not by joining `outbox` on
 * the event id. The relay's outbox row is reaped a day after it is published,
 * and a consumer replaying from offset 0 next month would find nothing to join
 * to. The message is self-sufficient; the outbox is not.
 *
 * An event for an account that is not a participant's cash account inserts
 * nothing, as before. A transaction id of 0 means "unknown" (a backfilled row
 * older than migration 0013) and is stored as NULL, as it was.
 */
export async function applyActivity(client: pg.PoolClient, event: Envelope): Promise<void> {
  await client.query(
    `INSERT INTO exchange_activity
       (participant_id, outbox_event_id, event_type, payload, occurred_at, transaction_id)
     SELECT p.id, $1::bigint, $2, $3::jsonb, $4::timestamptz, nullif($5::bigint, 0)
       FROM participants p
      WHERE p.cash_account_id = $6::bigint
     ON CONFLICT (outbox_event_id) DO NOTHING`,
    [
      event.eventId.toString(),
      event.type,
      JSON.stringify(event.payload ?? null),
      event.occurredAt,
      event.transactionId.toString(),
      event.accountId.toString(),
    ],
  );
}
