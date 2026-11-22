import type pg from 'pg';
import { encodeEnvelope } from '../events/envelope.ts';
import type { StringProducer } from '../events/kafka.ts';
import { relayBatches, relayEvents } from '../observability/metrics.ts';
import { claimBatch, type DrainResult, type OutboxEvent, type WorkerOptions } from './worker.ts';

/**
 * # The outbox relay
 *
 * The outbox worker with the event log as its publisher. The claim → publish →
 * settle shape from `worker.ts` is unchanged; what changes is that the publish
 * is **one produce request per claimed batch** rather than one call per event,
 * and that a broker outage is treated differently from a bad event.
 *
 * ## The row is marked published only after the broker acknowledged it
 *
 * The producer is idempotent, so `acks = all` is forced: the send resolves
 * once the partition leader has written the batch (with one broker, the
 * leader is the whole replica set). Only then does `markPublishedMany` run. A
 * crash between the ack and the mark republishes the batch on the next cycle —
 * a duplicate the broker cannot detect, because the new process is a new
 * producer id — and every consumer dedupes on `eventId`.
 *
 * ## One request per batch, and nothing concurrent
 *
 * A batch is claimed in id order within each shard, and `send()` keeps the
 * message order per partition. The next batch is not claimed until this one
 * is settled. That matters beyond tidiness: platformatic/kafka#472 reports
 * that *concurrent* idempotent sends can reorder after a reconnect. One send
 * in flight is the configuration that issue does not describe.
 *
 * ## A broker outage is not a failed event
 *
 * `markFailed` counts an attempt towards `max_attempts` and dead-letters the
 * row at the limit. That is right for an event the consumer rejects, and
 * exactly wrong for "the broker is down": eight failed polls during a
 * ten-minute outage would dead-letter every event written during it. So when
 * the send fails, the **whole batch** goes back to `pending` with the claim's
 * attempt increment undone and a short delay. The backlog grows in
 * `outbox_lag`, money keeps moving, and the batch drains in order when the
 * broker returns.
 *
 * Returning the whole batch also keeps order: if event 7 for an account fails
 * and event 8 is then sent, 8 has overtaken 7.
 */

export interface RelayOptions extends Omit<WorkerOptions, 'publish'> {
  producer: StringProducer;
  topic: string;
}

/** Mark a batch published in one statement. */
async function markPublishedMany(pool: pg.Pool, ids: bigint[]): Promise<void> {
  await pool.query(
    `UPDATE outbox SET state = 'published', published_at = now(),
            claimed_at = NULL, claimed_by = NULL
      WHERE id = ANY($1::bigint[]) AND state = 'in_flight'`,
    [ids.map(String)],
  );
}

/**
 * Hand a claimed batch back, as if it had not been claimed: `pending`, the
 * attempt the claim added undone, and eligible again after `delaySeconds`.
 */
export async function releaseClaims(
  pool: pg.Pool,
  ids: bigint[],
  error: unknown,
  delaySeconds: number,
): Promise<void> {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await pool.query(
    `UPDATE outbox
        SET state = 'pending',
            attempts = greatest(attempts - 1, 0),
            last_error = $2,
            available_at = now() + ($3 || ' seconds')::interval,
            claimed_at = NULL, claimed_by = NULL
      WHERE id = ANY($1::bigint[]) AND state = 'in_flight'`,
    [ids.map(String), `broker: ${detail}`, delaySeconds.toFixed(3)],
  );
}

export const toEnvelopeMessage = (topic: string, event: OutboxEvent) => ({
  topic,
  // Keyed by account: one account, one partition, one order.
  key: event.accountId.toString(),
  value: encodeEnvelope({
    eventId: event.id,
    type: event.eventType,
    accountId: event.accountId,
    transactionId: event.transactionId,
    occurredAt: event.createdAt,
    payload: event.payload,
  }),
  headers: { 'event-type': event.eventType },
});

/**
 * After an outage: every row a failed send handed back is eligible **now**.
 *
 * Without this, rows released late in an outage carried a backoff of up to
 * 30 s into the recovery and drained only when it expired — measured on the
 * first outage run as 102 rows waiting ~11 s after the broker was back
 * (docs/evidence/11-event-log.md). The broker answering is the signal those
 * backoffs were waiting for.
 */
export async function wakeReleased(pool: pg.Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE outbox SET available_at = now()
      WHERE state = 'pending' AND available_at > now() AND last_error LIKE 'broker: %'`,
  );
  return rowCount ?? 0;
}

export interface RelayResult extends DrainResult {
  /** Rows returned to pending because the broker could not be reached. */
  released: number;
}

/** One relay cycle. */
export async function relayOnce(options: RelayOptions, outageStreak = 0): Promise<RelayResult> {
  const events = await claimBatch({ ...options, publish: () => Promise.resolve() });
  const result: RelayResult = {
    claimed: events.length,
    published: 0,
    retried: 0,
    dead: 0,
    released: 0,
  };
  if (events.length === 0) return result;

  const ids = events.map((e) => e.id);

  try {
    await options.producer.send({
      messages: events.map((event) => toEnvelopeMessage(options.topic, event)),
    });
  } catch (err) {
    // Capped exponential delay: 1 s, 2 s, 4 s … 30 s while the outage lasts.
    const delay = Math.min(30, 2 ** Math.min(outageStreak, 5));
    await releaseClaims(options.pool, ids, err, delay);
    relayBatches.inc({ outcome: 'transient' });
    result.released = ids.length;
    throw Object.assign(new Error('relay: broker unavailable, batch released'), {
      cause: err,
      released: ids.length,
    });
  }

  await markPublishedMany(options.pool, ids);
  relayBatches.inc({ outcome: 'published' });
  relayEvents.inc(ids.length);
  result.published = ids.length;
  return result;
}
