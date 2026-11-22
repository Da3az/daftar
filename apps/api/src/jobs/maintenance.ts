import { Worker, type Job } from 'bullmq';
import type { Logger } from 'pino';
import type pg from 'pg';
import { jobOutcomes } from '../observability/metrics.ts';
import { takeEquitySnapshots } from './equity.ts';
import { createRedis, type Queues, type RedisConfig } from './queues.ts';

/**
 * # The maintenance queue
 *
 * Periodic work with no event behind it. Scheduled with Job Schedulers, which
 * live in Valkey — so on boot the schedulers are *upserted*, never assumed:
 * a Valkey that lost its data comes back with its schedules re-declared here.
 */

export const EQUITY_SCHEDULER_ID = 'equity-snapshot';

/**
 * The time a scheduler job was **meant** to run. BullMQ's scheduler jobs carry
 * it as `opts.prevMillis` (and in the id, `repeat:<scheduler>:<millis>`).
 * Falls back to the job's creation time for a job added by hand.
 */
export function scheduledAt(job: Job): Date {
  const prev = (job.opts as { prevMillis?: number }).prevMillis;
  return new Date(typeof prev === 'number' && prev > 0 ? prev : job.timestamp);
}

export async function declareMaintenanceSchedules(
  queues: Queues,
  options: { equityEveryMs: number },
): Promise<void> {
  await queues.maintenance.upsertJobScheduler(
    EQUITY_SCHEDULER_ID,
    { every: options.equityEveryMs },
    { name: 'equity.snapshot', data: {} },
  );
}

export function startMaintenanceWorker(pool: pg.Pool, redis: RedisConfig, log: Logger): Worker {
  const worker = new Worker(
    'maintenance',
    async (job) => {
      if (job.name === 'equity.snapshot') {
        const bucket = scheduledAt(job);
        const written = await takeEquitySnapshots(pool, bucket);
        jobOutcomes.inc({ queue: 'maintenance', outcome: written > 0 ? 'completed' : 'noop' });
        return { written };
      }
      throw new Error(`unknown maintenance job ${job.name}`);
    },
    {
      connection: createRedis(redis.url, 'daftar-worker-maintenance'),
      prefix: redis.prefix,
      concurrency: 1,
    },
  );
  worker.on('failed', (job, err) => {
    jobOutcomes.inc({ queue: 'maintenance', outcome: 'failed' });
    log.warn({ job: job?.name, err }, 'maintenance job failed');
  });
  return worker;
}
