import type pg from 'pg';
import { UNIQUE_VIOLATION, sqlstateOf } from '../ledger/sqlstate.ts';

/**
 * # Storing and processing an inbound webhook event
 *
 * The de-duplication, the state machine, and the payload-hash conflict check.
 * Signature verification happens before any of this — see `signature.ts`.
 *
 * ## Why a state column, and not just a unique index
 *
 * The tempting shape is: insert the event id; if the insert conflicts, we have
 * seen it, return 200. That returns **success for work that may still be
 * running or may have already failed** — in the one phase whose entire subject
 * is exactly-once delivery.
 *
 * Concretely: the provider delivers event X, we insert it and begin a ledger
 * write that takes 80 ms. At 40 ms the provider's retry arrives. The shortcut
 * answers 200, the provider marks the event delivered and never sends it again.
 * Our write then fails. The event is now permanently lost, and the provider's
 * dashboard says it was delivered successfully.
 *
 * So a replay arriving mid-processing gets **409**, which tells the provider to
 * retry later rather than to stop.
 */

export type WebhookState = 'received' | 'processing' | 'processed' | 'failed' | 'ignored';

export interface InboundEvent {
  provider: string;
  idempotencyKey: string;
  objectId: string;
  eventType: string;
  payloadHash: string;
  payload: unknown;
  signatureValid: boolean;
  signedAt: Date | null;
  withinWindow: boolean;
}

export type IngestOutcome =
  /** First delivery. The caller owns it and must process it. */
  | { status: 'accepted'; id: bigint }
  /** Already finished. Replay the terminal state; do not re-run the work. */
  | { status: 'duplicate'; id: bigint; state: WebhookState; deliveryCount: number }
  /**
   * A concurrent delivery is processing this key right now. The caller must
   * answer 409 so the provider retries rather than giving up.
   */
  | { status: 'in_flight'; id: bigint; deliveryCount: number }
  /**
   * Same key, **different payload bytes**. A provider bug, or a modified replay
   * that somehow passed the signature check. Logged and alerted, never silently
   * accepted — and detectable only because the payload hash is stored.
   */
  | {
      status: 'payload_conflict';
      id: bigint;
      storedHash: string;
      incomingHash: string;
      deliveryCount: number;
    };

/**
 * Record a delivery and decide whether this caller should process it.
 *
 * One statement claims the key, exactly as the Phase 4 order path does: the
 * unique index arbitrates, not a prior `SELECT`.
 */
export async function ingest(pool: pg.Pool, event: InboundEvent): Promise<IngestOutcome> {
  try {
    const inserted = await pool.query<{ id: bigint }>(
      `INSERT INTO webhook_events
         (provider, idempotency_key, object_id, event_type, payload_hash, payload,
          signature_valid, signed_at, within_window, state)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'received')
       ON CONFLICT (provider, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        event.provider,
        event.idempotencyKey,
        event.objectId,
        event.eventType,
        event.payloadHash,
        JSON.stringify(event.payload ?? null),
        event.signatureValid,
        event.signedAt,
        event.withinWindow,
      ],
    );

    const id = inserted.rows[0]?.id;
    if (id !== undefined) return { status: 'accepted', id };
  } catch (err) {
    // Only a genuine race against another insert of the same key reaches here,
    // and only if ON CONFLICT somehow did not apply. Fall through to the read.
    if (sqlstateOf(err) !== UNIQUE_VIOLATION) throw err;
  }

  /**
   * A repeat delivery. `delivery_count` is bumped in the same statement that
   * reads the state, so the duplicate rate is observable without a second round
   * trip and without a read-then-write race of its own.
   */
  const { rows } = await pool.query<{
    id: bigint;
    state: WebhookState;
    payload_hash: string;
    delivery_count: number;
  }>(
    `UPDATE webhook_events
        SET delivery_count = delivery_count + 1
      WHERE provider = $1 AND idempotency_key = $2
      RETURNING id, state, payload_hash, delivery_count`,
    [event.provider, event.idempotencyKey],
  );

  const row = rows[0];
  if (!row) {
    // Deleted by the reaper between the conflict and this read. Treat as a
    // fresh delivery rather than guessing.
    return ingest(pool, event);
  }

  /**
   * Payload conflict is checked **before** state, for the same reason the order
   * path checks its request hash first: a provider sending two different bodies
   * under one id has a bug, and that is true whether the first one finished or
   * not. Reporting "duplicate, already processed" would hide it.
   */
  if (row.payload_hash !== event.payloadHash) {
    /**
     * Record that a conflicting delivery happened, on the surviving row.
     *
     * The conflicting payload itself is NOT stored — storing it would mean
     * accepting bytes the system has decided are untrustworthy. But the *event*
     * of the conflict has to be recorded somewhere, or it exists only in a log
     * line and the Settlements page cannot show it.
     *
     * Migration 0008 exists because the first version of this had a view that
     * counted distinct payload hashes per key — which could never return a row,
     * since the unique index permits only one row per key and this branch
     * rejects the second payload. A check that cannot fire is worse than no
     * check: it reads as a clean result.
     */
    await pool.query(
      `UPDATE webhook_events
          SET payload_conflict_count = payload_conflict_count + 1,
              last_conflicting_hash = $2
        WHERE id = $1::bigint`,
      [row.id.toString(), event.payloadHash],
    );

    return {
      status: 'payload_conflict',
      id: row.id,
      storedHash: row.payload_hash,
      incomingHash: event.payloadHash,
      deliveryCount: row.delivery_count,
    };
  }

  if (row.state === 'received' || row.state === 'processing') {
    return { status: 'in_flight', id: row.id, deliveryCount: row.delivery_count };
  }

  return {
    status: 'duplicate',
    id: row.id,
    state: row.state,
    deliveryCount: row.delivery_count,
  };
}

/**
 * Move `received` -> `processing`, atomically, and only if it is still
 * `received`.
 *
 * The `WHERE state = 'received'` is the whole point: two concurrent deliveries
 * that both got past `ingest` cannot both begin processing, because only one
 * `UPDATE` will match. Returns false for the loser, which then answers 409.
 */
export async function beginProcessing(pool: pg.Pool, id: bigint): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE webhook_events SET state = 'processing'
      WHERE id = $1::bigint AND state = 'received'`,
    [id.toString()],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Settle an event.
 *
 * Takes a `client` so it can run inside the same transaction as the ledger write
 * it describes. Marking an event processed in a separate transaction leaves a
 * window where the money has moved and the event still says `processing` — and
 * a replay in that window gets a 409 for work that definitely succeeded.
 */
export async function settle(
  client: pg.PoolClient | pg.Pool,
  id: bigint,
  outcome: {
    state: 'processed' | 'failed' | 'ignored';
    transactionId?: bigint;
    errorDetail?: string;
  },
): Promise<void> {
  await client.query(
    `UPDATE webhook_events
        SET state = $2::webhook_state,
            transaction_id = $3::bigint,
            error_detail = $4,
            processed_at = now()
      WHERE id = $1::bigint`,
    [
      id.toString(),
      outcome.state,
      outcome.transactionId?.toString() ?? null,
      outcome.errorDetail ?? null,
    ],
  );
}

/**
 * Has this object already been settled under a *different* event id?
 *
 * An event id alone is insufficient de-duplication: the same underlying change
 * can arrive as two separately generated events — a provider replaying from a
 * different worker, a backfill, an operator re-sending from a dashboard. Both
 * have distinct ids, so `(provider, idempotency_key)` lets both through.
 *
 * Keying on `(object_id, event_type)` as well is what catches it. Deliberately a
 * query rather than a unique constraint, because a legitimate sequence of events
 * can touch one object repeatedly (`received`, then `settled`, then
 * `reconciled`) — only a repeat of the *same* type on the same object is a
 * duplicate.
 */
export async function alreadySettledForObject(
  pool: pg.Pool,
  event: { provider: string; objectId: string; eventType: string; excludeId: bigint },
): Promise<{ duplicate: boolean; existingKey?: string }> {
  const { rows } = await pool.query<{ idempotency_key: string }>(
    `SELECT idempotency_key FROM webhook_events
      WHERE provider = $1 AND object_id = $2 AND event_type = $3
        AND id <> $4::bigint
        AND state IN ('processed', 'ignored')
      LIMIT 1`,
    [event.provider, event.objectId, event.eventType, event.excludeId.toString()],
  );

  const existing = rows[0]?.idempotency_key;
  return existing === undefined ? { duplicate: false } : { duplicate: true, existingKey: existing };
}

/** Delete old events. "Mark done" with no cleanup means the table grows forever. */
export async function reap(pool: pg.Pool, olderThanDays = 30): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM webhook_events
      WHERE received_at < now() - ($1 || ' days')::interval
        AND state IN ('processed', 'ignored', 'failed')`,
    [String(olderThanDays)],
  );
  return rowCount ?? 0;
}
