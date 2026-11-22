import { createPool } from '../../db/pool.ts';
import { env } from '../../env.ts';
import { encodeEnvelope } from '../envelope.ts';
import { createAdmin, createProducer } from '../kafka.ts';
import { highWatermarks } from '../offsets.ts';
import { topicNames } from '../topics.ts';

/**
 * `npm run kafka:backfill` — put the history that predates the event log on it.
 *
 * Run **once**, with the outbox worker stopped, before switching
 * `OUTBOX_PUBLISHER` to `kafka`. Every event the direct publisher ever
 * delivered is in `exchange_activity`, with its original outbox id, so it is
 * produced here with that id: consumers dedupe on it, and a replay from offset
 * 0 then covers everything rather than "everything since the cutover".
 *
 * Order: by outbox id, which is per-account commit order. If the relay were
 * already running, a new event for an account could land on its partition
 * before that account's history — so this refuses to run against a topic that
 * already has messages, unless `--force`.
 *
 * ## What it cannot recover, and says so
 *
 * Guest trades made before the outbox existed (before migration 0012) have no
 * outbox row and no feed row, so there is nothing to backfill them from. A
 * positions projection built from the log will not include them, and the
 * reconciler will report those positions. They are counted below rather than
 * papered over with invented event ids.
 */

const force = process.argv.includes('--force');
const BATCH = 500;

const pool = createPool({
  connectionString: env.DATABASE_URL,
  max: 2,
  statementTimeoutMs: 0,
  applicationName: 'daftar-backfill',
});
const topics = topicNames(env.KAFKA_NAMESPACE);
const kafka = { brokers: env.KAFKA_BROKERS, clientId: 'daftar-backfill' };
const admin = createAdmin(kafka);
const producer = createProducer(kafka);

try {
  const high = await highWatermarks(admin, topics.events);
  const existing = [...high.values()].reduce((a, b) => a + b, 0n);
  if (existing > 0n && !force) {
    throw new Error(
      `${topics.events} already holds ${existing.toString()} messages; refusing to interleave ` +
        'history with live events (pass --force if this is a deliberate re-run)',
    );
  }

  let after = 0n;
  let produced = 0;
  for (;;) {
    const { rows } = await pool.query<{
      outbox_event_id: bigint;
      event_type: string;
      payload: unknown;
      occurred_at: string;
      transaction_id: bigint | null;
      cash_account_id: bigint;
    }>(
      `SELECT a.outbox_event_id, a.event_type, a.payload, a.occurred_at, a.transaction_id,
              p.cash_account_id
         FROM exchange_activity a
         JOIN participants p ON p.id = a.participant_id
        WHERE a.outbox_event_id > $1::bigint
        ORDER BY a.outbox_event_id
        LIMIT $2::int`,
      [after.toString(), BATCH],
    );
    if (rows.length === 0) break;

    await producer.send({
      messages: rows.map((r) => ({
        topic: topics.events,
        key: r.cash_account_id.toString(),
        value: encodeEnvelope({
          eventId: r.outbox_event_id,
          type: r.event_type,
          accountId: r.cash_account_id,
          // 0 = unknown: rows older than migration 0013 never had it copied.
          transactionId: r.transaction_id ?? 0n,
          occurredAt: r.occurred_at,
          payload: r.payload,
        }),
        headers: { 'event-type': r.event_type, backfill: 'true' },
      })),
    });

    produced += rows.length;
    after = rows[rows.length - 1]!.outbox_event_id;
    process.stdout.write(`produced ${String(produced)} (through event ${after.toString()})\n`);
  }

  const { rows: gaps } = await pool.query<{ trades: bigint; guests: bigint }>(
    `SELECT count(*)::bigint AS trades, count(DISTINCT o.participant_id)::bigint AS guests
       FROM trades t
       JOIN book_orders o ON o.id IN (t.taker_order_id, t.maker_order_id)
       JOIN participants p ON p.id = o.participant_id AND p.kind = 'guest'
      WHERE NOT EXISTS (
        SELECT 1 FROM exchange_activity a
         WHERE a.participant_id = o.participant_id
           AND a.event_type = 'trade.' || o.side
           AND a.transaction_id = t.transaction_id
      )`,
  );
  const gap = gaps[0]!;
  process.stdout.write(`\nbackfilled ${String(produced)} events into ${topics.events}\n`);
  process.stdout.write(
    `guest fills with no event to backfill from: ${gap.trades.toString()} ` +
      `(${gap.guests.toString()} guests). Includes fills whose feed row predates migration ` +
      '0013 and so has no transaction id to match on.\n',
  );
} catch (err) {
  process.stderr.write(`backfill failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await producer.close();
  await admin.close();
  await pool.end();
}
