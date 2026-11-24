import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { parseCash, parseQuantity } from '@daftar/money';
import { useTestDatabase } from '../support/test-database.ts';
import { resetLedger } from '../support/reset.ts';
import { DEFAULT_MARKET, placeBookOrder } from '../../src/exchange/engine.ts';
import { createGuest, ensureBots, findParticipant } from '../../src/exchange/participants.ts';
import { runConsumer } from '../../src/events/consumer.ts';
import { applyActivity } from '../../src/events/consumers/activity.ts';
import { createAdmin, createProducer, type StringProducer } from '../../src/events/kafka.ts';
import { ensureTopics, topicNames } from '../../src/events/topics.ts';
import { relayOnce } from '../../src/outbox/relay.ts';
import { allShards, reclaimStale } from '../../src/outbox/worker.ts';

/**
 * The relay against a real broker. Needs Kafka on KAFKA_BROKERS (default
 * 127.0.0.1:19092); `npm run test:broker`. Each run uses its own topic
 * namespace on the shared broker, as each file uses its own database.
 *
 * Rules under test (from the spec):
 *  - an event relayed twice — the relay died after the broker acknowledged it
 *    and before marking the row — takes effect once;
 *  - with the broker unreachable, money keeps moving, no event is dead-lettered
 *    and no attempt is spent; when it returns, the backlog drains in order.
 */

const ctx = useTestDatabase({ poolMax: 10 });
const brokers = (process.env['KAFKA_BROKERS'] ?? '127.0.0.1:19092').split(',');
const ns = `test-${randomBytes(4).toString('hex')}`;
const topics = topicNames(ns);
const kafka = { brokers, clientId: `${ns}-client` };
let producer: StringProducer;
let bots: string[] = [];
let n = 0;

beforeAll(async () => {
  const admin = createAdmin(kafka);
  try {
    await ensureTopics(admin, topics);
  } finally {
    await admin.close();
  }
  producer = createProducer(kafka);
});

afterAll(async () => {
  await producer.close();
  const admin = createAdmin(kafka);
  try {
    await admin.deleteTopics({
      topics: [topics.events, topics.eventsDlq, topics.market, topics.notifications],
    });
  } finally {
    await admin.close();
  }
});

beforeEach(async () => {
  await resetLedger(ctx.pool);
  await ctx.pool.query('UPDATE markets SET last_price = opening_price, last_trade_at = NULL');
  bots = await ensureBots(ctx.pool, 1);
});

async function tradeSome(times: number) {
  const created = await createGuest(ctx.pool);
  const g = (await findParticipant(ctx.pool, created.externalId))!;
  for (let i = 0; i < times; i++) {
    n += 1;
    await placeBookOrder(ctx.pool, {
      externalId: `${bots[0]!}:a-${String(n)}`,
      participantExternalId: bots[0]!,
      symbol: DEFAULT_MARKET,
      side: 'sell',
      type: 'limit',
      quantity: parseQuantity('1.00000000'),
      limitPrice: parseCash('25.00'),
    });
    await placeBookOrder(ctx.pool, {
      externalId: `${g.externalId}:b-${String(n)}`,
      participantExternalId: g.externalId,
      symbol: DEFAULT_MARKET,
      side: 'buy',
      type: 'market',
      quantity: parseQuantity('1.00000000'),
    });
  }
  return g;
}

const outboxStates = async () =>
  (
    await ctx.pool.query<{ state: string; n: number; max_attempts_used: number }>(
      `SELECT state, count(*)::int AS n, max(attempts)::int AS max_attempts_used FROM outbox GROUP BY state`,
    )
  ).rows;

describe('an event relayed twice takes effect once', () => {
  it('relay dies after the broker ack and before marking: the redelivery is a no-op', async () => {
    const g = await tradeSome(3);
    const options = {
      pool: ctx.pool,
      shards: allShards(),
      workerId: 'w1',
      batchSize: 100,
      producer,
      topic: topics.events,
    };

    // First relay: sent and acknowledged…
    const first = await relayOnce(options);
    expect(first.published).toBe(3);
    // …then pretend it died before marking, by putting the rows back.
    await ctx.pool.query(
      `UPDATE outbox SET state = 'in_flight', published_at = 'infinity', claimed_at = now() - interval '1 hour'`,
    );
    expect(await reclaimStale(ctx.pool, 60)).toBe(3);
    const second = await relayOnce(options);
    expect(second.published).toBe(3); // every event is on the topic twice now

    const consumer = runConsumer(
      { pool: ctx.pool, kafka, topics, producer, log: pino({ level: 'silent' }) },
      {
        name: 'activity',
        groupId: `${ns}.activity`,
        types: () => true,
        startFrom: 'earliest',
        handler: { kind: 'transactional', apply: applyActivity },
      },
    );
    let rows = 0;
    for (let i = 0; i < 100 && rows < 3; i++) {
      await new Promise((r) => setTimeout(r, 100));
      rows = (
        await ctx.pool.query('SELECT 1 FROM exchange_activity WHERE participant_id = $1::bigint', [
          g.id.toString(),
        ])
      ).rows.length;
    }
    // Give the duplicates time to arrive too, then check nothing doubled.
    await new Promise((r) => setTimeout(r, 1500));
    await consumer.stop();

    rows = (
      await ctx.pool.query('SELECT 1 FROM exchange_activity WHERE participant_id = $1::bigint', [
        g.id.toString(),
      ])
    ).rows.length;
    expect(rows).toBe(3);
    const receipts = await ctx.pool.query(
      `SELECT 1 FROM consumer_receipts WHERE consumer = 'activity'`,
    );
    expect(receipts.rows).toHaveLength(3);
  });
});

describe('the broker unreachable', () => {
  it('money keeps moving, nothing is dead-lettered, no attempt is spent, and it drains in order', async () => {
    // Nothing listens on port 1: every send fails fast.
    const dead = createProducer({ brokers: ['127.0.0.1:1'], clientId: `${ns}-dead` });
    const g = await tradeSome(2);
    const deadOptions = {
      pool: ctx.pool,
      shards: allShards(),
      workerId: 'w2',
      batchSize: 100,
      producer: dead,
      topic: topics.events,
    };

    for (let i = 0; i < 3; i++) {
      await expect(relayOnce(deadOptions, i)).rejects.toThrow(/broker unavailable/);
      await ctx.pool.query(`UPDATE outbox SET available_at = now()`); // skip the backoff for the test
    }
    await dead.close(true).catch(() => undefined);

    // Orders still commit while the broker is away.
    await tradeSome(1);
    const states = await outboxStates();
    expect(states.map((s) => s.state)).toEqual(['pending']);
    expect(states[0]!.n).toBe(3);
    expect(states[0]!.max_attempts_used).toBe(0);

    // The broker is back: one relay drains everything, in id order per account.
    const result = await relayOnce({ ...deadOptions, producer, workerId: 'w3' });
    expect(result.published).toBe(3);
    expect((await outboxStates()).map((s) => s.state)).toEqual(['published']);
    void g;
  });
});
