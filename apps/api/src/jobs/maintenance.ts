import { Worker, type Job } from 'bullmq';
import type { Logger } from 'pino';
import type pg from 'pg';
import { jobOutcomes } from '../observability/metrics.ts';
import { takeEquitySnapshots } from './equity.ts';
import { sweepWithdrawals } from './rail.ts';
import { syncSchedules } from './dca.ts';
import { createRedis, type Queues, type RedisConfig } from './queues.ts';

/**
 * # The maintenance queue
 *
 * Periodic work with no event behind it. Scheduled with Job Schedulers, which
 * live in Valkey — so on boot the schedulers are *upserted*, never assumed:
 * a Valkey that lost its data comes back with its schedules re-declared here.
 */

export const EQUITY_SCHEDULER_ID = 'equity-snapshot';
export const WITHDRAWAL_SWEEP_ID = 'withdrawal-sweep';
export const DCA_SYNC_ID = 'dca-sync';

/**
 * The time a scheduler job was **meant** to run.
 *
 * BullMQ names each scheduler tick `repeat:<scheduler id>:<scheduled millis>`
 * — that suffix is the tick's identity, and it is read from there. Not
 * `job.timestamp`, which was the first version of this function and was wrong:
 * the next tick's job is created when the previous one is taken, so its
 * timestamp is the *previous* tick's run time. Observed on the first live run
 * (two ticks a minute apart, both recorded at 12:25:09, distinct only by one
 * millisecond); had they landed in the same millisecond the second run would
 * have been deduplicated away. `opts.prevMillis` was not set on these jobs in
 * BullMQ 6.7.8 either.
 *
 * Falls back to the creation time only for a job added by hand.
 */
export function scheduledAt(job: Job): Date {
  const match = /^repeat:.+:(\d{10,})$/.exec(job.id ?? '');
  if (match) return new Date(Number(match[1]));
  return new Date(job.timestamp);
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
  await queues.maintenance.upsertJobScheduler(
    WITHDRAWAL_SWEEP_ID,
    { every: 60_000 },
    { name: 'withdrawals.sweep', data: {} },
  );
  await queues.maintenance.upsertJobScheduler(
    DCA_SYNC_ID,
    { every: 30_000 },
    { name: 'dca.sync', data: {} },
  );
}

export function startMaintenanceWorker(
  pool: pg.Pool,
  queues: Queues,
  redis: RedisConfig,
  log: Logger,
): Worker {
  const worker = new Worker(
    'maintenance',
    async (job) => {
      if (job.name === 'equity.snapshot') {
        const bucket = scheduledAt(job);
        const written = await takeEquitySnapshots(pool, bucket);
        jobOutcomes.inc({ queue: 'maintenance', outcome: written > 0 ? 'completed' : 'noop' });
        return { written };
      }
      if (job.name === 'dca.sync') {
        await syncSchedules(pool, queues.dca, log);
        jobOutcomes.inc({ queue: 'maintenance', outcome: 'completed' });
        return {};
      }
      if (job.name === 'withdrawals.sweep') {
        const redriven = await sweepWithdrawals(pool, queues, log);
        jobOutcomes.inc({ queue: 'maintenance', outcome: redriven > 0 ? 'completed' : 'noop' });
        return { redriven };
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
