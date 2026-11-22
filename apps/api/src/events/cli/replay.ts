import { setTimeout as sleep } from 'node:timers/promises';
import { createPool } from '../../db/pool.ts';
import { env } from '../../env.ts';
import { positionAccountExternalId } from '../../exchange/engine.ts';
import { positionFromTrades } from '../../exchange/positions.ts';
import { logger } from '../../logging.ts';
import { runConsumer } from '../consumer.ts';
import { applyPosition, isTradeEvent } from '../consumers/positions.ts';
import { createAdmin, createProducer } from '../kafka.ts';
import { committedOffsets, highWatermarks, totalLag } from '../offsets.ts';
import { groupNames, topicNames } from '../topics.ts';

/**
 * `npm run projections:replay -- positions`
 *
 * Drop the positions projection, rebuild it from offset 0 of the event log,
 * and diff the result against the ledger. Exit code 1 on any difference —
 * which is the claim being tested: the projection is a pure function of the
 * log, and the log is complete.
 *
 * 1. **Refuse if the group has live members.** Resetting offsets under a
 *    running consumer would race it; stop the worker process first.
 * 2. Truncate the projection and its receipts in one transaction.
 * 3. Delete the consumer group, so its committed offsets go with it; the
 *    consumer below then starts from `earliest`.
 * 4. Snapshot the high watermark, consume until committed ≥ that snapshot.
 *    Events written during the replay are applied too, but the run does not
 *    wait for them.
 * 5. Compare every rebuilt position with `positionFromTrades()` and with the
 *    ledger balance of the position account.
 *
 * Only `positions` is supported. The activity feed is what guests read as
 * their history; truncating it is not a maintenance operation.
 */

const which = process.argv[2];
if (which !== 'positions') {
  process.stderr.write('usage: projections:replay -- positions\n');
  process.exit(64); // EX_USAGE
}

const pool = createPool({
  connectionString: env.DATABASE_URL,
  max: 4,
  statementTimeoutMs: 0,
  applicationName: 'daftar-replay',
});
const topics = topicNames(env.KAFKA_NAMESPACE);
const group = groupNames(env.KAFKA_NAMESPACE).positions;
const kafka = { brokers: env.KAFKA_BROKERS, clientId: 'daftar-replay' };
const admin = createAdmin(kafka);
const producer = createProducer(kafka);

const ms = (start: bigint) => Number((process.hrtime.bigint() - start) / 1_000_000n);

try {
  const described = await admin.describeGroups({ groups: [group] });
  const state = described.get(group);
  if (state && state.members.size > 0) {
    throw new Error(
      `consumer group ${group} has ${String(state.members.size)} live member(s); stop the worker process first`,
    );
  }

  const started = process.hrtime.bigint();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE proj_positions');
    await client.query(`DELETE FROM consumer_receipts WHERE consumer = 'positions'`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (state) await admin.deleteGroups({ groups: [group] });

  const target = await highWatermarks(admin, topics.events);
  const messages = [...target.values()].reduce((a, b) => a + b, 0n);
  process.stdout.write(
    `replaying ${messages.toString()} messages from offset 0 of ${topics.events}\n`,
  );

  const consumer = runConsumer(
    { pool, kafka, topics, producer, log: logger },
    {
      name: 'positions',
      groupId: group,
      types: isTradeEvent,
      startFrom: 'earliest',
      handler: { kind: 'transactional', apply: applyPosition },
    },
  );

  for (;;) {
    await sleep(500);
    const lag = totalLag(target, await committedOffsets(admin, group, topics.events));
    if (lag === 0n) break;
  }
  await consumer.stop();
  const replayMs = ms(started);

  // ---- the diff ---------------------------------------------------------
  const { rows: subjects } = await pool.query<{
    participant_id: bigint;
    external_id: string;
    symbol: string;
    quantity: bigint | null;
    cost_basis: bigint | null;
    realised_pnl: bigint | null;
  }>(
    `WITH traded AS (
       SELECT DISTINCT o.participant_id, t.symbol
         FROM trades t
         JOIN book_orders o ON o.id IN (t.taker_order_id, t.maker_order_id)
         JOIN participants p ON p.id = o.participant_id AND p.kind = 'guest'
       UNION
       SELECT participant_id, symbol FROM proj_positions
     )
     SELECT tr.participant_id, p.external_id, tr.symbol,
            pp.quantity, pp.cost_basis, pp.realised_pnl
       FROM traded tr
       JOIN participants p ON p.id = tr.participant_id
       LEFT JOIN proj_positions pp
              ON pp.participant_id = tr.participant_id AND pp.symbol = tr.symbol
      ORDER BY tr.participant_id, tr.symbol`,
  );

  let diffs = 0;
  for (const s of subjects) {
    const truth = await positionFromTrades(pool, s.participant_id, s.symbol);
    const { rows: bal } = await pool.query<{ balance: bigint }>(
      'SELECT balance FROM accounts WHERE external_id = $1',
      [positionAccountExternalId(s.external_id, s.symbol)],
    );
    const held = bal[0]?.balance ?? 0n;
    const got = {
      quantity: s.quantity ?? 0n,
      costBasis: s.cost_basis ?? 0n,
      realisedPnl: s.realised_pnl ?? 0n,
    };
    const problems: string[] = [];
    if (got.quantity !== held) problems.push(`quantity ${got.quantity} ≠ ledger ${held}`);
    if (got.costBasis !== truth.costBasis)
      problems.push(`cost ${got.costBasis} ≠ trades ${truth.costBasis}`);
    if (got.realisedPnl !== truth.realisedPnl) {
      problems.push(`realised ${got.realisedPnl} ≠ trades ${truth.realisedPnl}`);
    }
    if (problems.length > 0) {
      diffs += 1;
      process.stdout.write(
        `DIFF participant ${s.participant_id.toString()} ${s.symbol}: ${problems.join('; ')}\n`,
      );
    }
  }

  process.stdout.write(
    `\nreplay: ${messages.toString()} messages in ${String(replayMs)} ms; ` +
      `${String(subjects.length)} positions compared, ${String(diffs)} differ\n`,
  );
  if (diffs > 0) process.exitCode = 1;
} catch (err) {
  process.stderr.write(`replay failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await producer.close();
  await admin.close();
  await pool.end();
}
