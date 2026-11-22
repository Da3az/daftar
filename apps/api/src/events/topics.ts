import type { Admin } from '@platformatic/kafka';

/**
 * # Topics
 *
 * Every name is derived from a namespace, so the broker test suite can give
 * each test file a private set of topics on one broker — the same isolation
 * each file gets from its own cloned database.
 *
 * ## `events` — the relay's destination
 *
 * - **16 partitions**, keyed by account id. Ordering only matters per account,
 *   and one key always lands on one partition. 16 matches the outbox's shard
 *   count, though nothing depends on the two being equal.
 * - **`retention.ms = -1`.** Projections are rebuilt by replaying from offset
 *   0, so the log must hold everything. Deleting old segments would make
 *   "rebuildable" true only for the last week.
 * - **Replication factor 1.** One broker. A lost disk loses the log — and
 *   nothing else, because PostgreSQL is the source of truth and the log can be
 *   re-derived from `exchange_activity` (see `kafka:backfill`).
 *
 * ## `events.dlq` — poison messages, parked for a human
 *
 * ## `notifications` — "a notification was written", for live push
 *
 * ## `market` — snapshots of the book and tape, for live push
 *
 * Short retention: a client that missed a tick refetches the book over HTTP;
 * nothing replays market data.
 */

export interface TopicNames {
  events: string;
  eventsDlq: string;
  market: string;
  notifications: string;
}

export const topicNames = (namespace: string): TopicNames => ({
  events: `${namespace}.exchange.events.v1`,
  eventsDlq: `${namespace}.exchange.events.dlq.v1`,
  market: `${namespace}.exchange.market.v1`,
  notifications: `${namespace}.exchange.notifications.v1`,
});

/** Consumer group names, one per independent reader of the events topic. */
export const groupNames = (namespace: string) => ({
  activity: `${namespace}.activity`,
  positions: `${namespace}.positions`,
  reconciler: `${namespace}.reconciler`,
  withdrawals: `${namespace}.withdrawals-dispatcher`,
  notifier: `${namespace}.notifier`,
});

export type ConsumerName = keyof ReturnType<typeof groupNames>;

export const EVENTS_PARTITIONS = 16;

interface TopicSpec {
  topic: string;
  partitions: number;
  configs: { name: string; value: string }[];
}

export function topicSpecs(names: TopicNames): TopicSpec[] {
  return [
    {
      topic: names.events,
      partitions: EVENTS_PARTITIONS,
      configs: [
        { name: 'retention.ms', value: '-1' },
        { name: 'retention.bytes', value: '-1' },
        { name: 'cleanup.policy', value: 'delete' },
      ],
    },
    {
      topic: names.eventsDlq,
      partitions: 1,
      configs: [
        { name: 'retention.ms', value: '-1' },
        { name: 'cleanup.policy', value: 'delete' },
      ],
    },
    {
      // Written after a notification row commits, read by API instances to
      // push it. Lossy by design: a client that misses one reads the list.
      topic: names.notifications,
      partitions: 4,
      configs: [
        { name: 'retention.ms', value: String(7 * 24 * 60 * 60 * 1000) },
        { name: 'cleanup.policy', value: 'delete' },
      ],
    },
    {
      topic: names.market,
      partitions: 1,
      configs: [
        // One day.
        { name: 'retention.ms', value: String(24 * 60 * 60 * 1000) },
        { name: 'cleanup.policy', value: 'delete' },
      ],
    },
  ];
}

/**
 * Create whichever topics do not exist yet. Idempotent: run it on every
 * deploy. Never changes an existing topic's partition count — that would move
 * keys between partitions and break per-account ordering for in-flight data.
 */
export async function ensureTopics(admin: Admin, names: TopicNames): Promise<string[]> {
  const existing = new Set(await admin.listTopics());
  const created: string[] = [];

  for (const spec of topicSpecs(names)) {
    if (existing.has(spec.topic)) continue;
    await admin.createTopics({
      topics: [spec.topic],
      partitions: spec.partitions,
      replicas: 1,
      configs: spec.configs,
    });
    created.push(spec.topic);
  }

  return created;
}
