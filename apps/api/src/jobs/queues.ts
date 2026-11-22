import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * # BullMQ queues
 *
 * ## Connections are constructed here, not described
 *
 * BullMQ can build its own ioredis client from options, but it loads ioredis
 * with `require()` — which does not exist in native ESM, and this codebase is
 * native ESM. Passing options fails at runtime with "could not load the
 * optional 'ioredis' package". So every Queue and Worker gets a client built
 * here.
 *
 * `maxRetriesPerRequest: null` is required for Workers: their blocking
 * commands must wait out a Valkey restart instead of failing after 20
 * retries, which would stop the worker with no error you would notice.
 * BullMQ forces it for the connections it creates itself; for a client we
 * pass in, it is on us.
 *
 * ## Retention is longer than the redelivery window
 *
 * A job id is only a dedup key while the job still exists. If a completed job
 * were removed at once, a Kafka redelivery of the event that created it would
 * add it again and run it twice. Completed jobs are kept for a day — far longer
 * than any consumer is down before its offset is redelivered — and capped by
 * count, so Valkey's `maxmemory` (with `noeviction`, which refuses writes
 * rather than dropping keys) is not reached by history.
 *
 * Even so, **BullMQ dedup is an optimisation**. Every job body checks a
 * Postgres state or unique key before it acts, so a job that runs twice does
 * its work once.
 */

export const QUEUE_NAMES = {
  rail: 'rail',
  notify: 'notify',
  dca: 'dca',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface RedisConfig {
  url: string;
  prefix: string;
}

export function createRedis(url: string, name: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: name,
    // Reconnect with a capped backoff, forever. A Valkey restart is an outage
    // to wait out, not a reason for the worker process to give up.
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 50_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 10_000 },
};

export function createQueue(config: RedisConfig, name: QueueName): Queue {
  return new Queue(name, {
    connection: createRedis(config.url, `daftar-queue-${name}`),
    prefix: config.prefix,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

/**
 * Job ids: `<eventId>-<action>`. BullMQ rejects an id that is an integer
 * string, and treats `:` as a separator for its own repeatable-job keys, so
 * both are ruled out by construction.
 */
export function jobId(...parts: (string | bigint | number)[]): string {
  const id = parts.map(String).join('-');
  if (id.includes(':')) throw new RangeError(`job id must not contain ':' (${id})`);
  if (/^[0-9]+$/.test(id)) throw new RangeError(`job id must not be all digits (${id})`);
  return id;
}

export type Queues = Record<QueueName, Queue>;

export function createQueues(config: RedisConfig): Queues {
  return {
    rail: createQueue(config, 'rail'),
    notify: createQueue(config, 'notify'),
    dca: createQueue(config, 'dca'),
    maintenance: createQueue(config, 'maintenance'),
  };
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all(Object.values(queues).map((q) => q.close()));
}
