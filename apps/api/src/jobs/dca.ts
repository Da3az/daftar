import { Worker, type Queue } from 'bullmq';
import type { Logger } from 'pino';
import type pg from 'pg';
import { z } from 'zod';
import { activePlans, firePlan, type Plan } from '../exchange/recurring.ts';
import { jobOutcomes } from '../observability/metrics.ts';
import { scheduledAt } from './maintenance.ts';
import { createRedis, type RedisConfig } from './queues.ts';

/**
 * # Recurring buys: one Job Scheduler per plan
 *
 * The scheduler id **is** the plan id (`rp-<uuid>`: no `:`, not all digits).
 * Each tick is a job whose scheduled time BullMQ records as `prevMillis`; that
 * time, not the moment the job happened to run, is the run's identity — so a
 * job retried ten minutes late is still the 09:00 run, and still one order.
 *
 * ## Postgres says what is scheduled
 *
 * The API only writes `recurring_plans`; it has no Valkey connection at all.
 * The worker process runs `syncSchedules` on boot and every 30 s, making the
 * schedulers match the table — adding new and resumed plans, removing paused
 * and deleted ones. And every firing re-reads the plan and does nothing unless
 * it is still active, so a scheduler that briefly outlives its plan cannot
 * make a paused plan buy.
 *
 * ## What happens to runs missed while the workers were down
 *
 * Not backfilled. A scheduler keeps one delayed job for its next tick and
 * creates the following one when that job is taken; while no worker runs,
 * that one job waits (it runs late when the workers return, as its scheduled
 * time) and no further ticks are created. That reading of BullMQ is from its
 * source (`classes/job-scheduler.js`) and is unverified by a run. Either way
 * this code does not catch up: buying several times at once at today's price
 * is not what the guest asked for, and the run history shows the gap.
 */

export async function scheduleFor(queue: Queue, plan: Pick<Plan, 'id' | 'everyMs'>): Promise<void> {
  await queue.upsertJobScheduler(
    plan.id,
    { every: plan.everyMs },
    { name: 'dca.fire', data: { planId: plan.id } },
  );
}

/** Make Valkey's schedulers match the table. Run on worker boot. */
export async function syncSchedules(pool: pg.Pool, queue: Queue, log: Logger): Promise<void> {
  const plans = await activePlans(pool);
  const wanted = new Set(plans.map((p) => p.id));
  const existing = await queue.getJobSchedulers(0, -1);
  const scheduled = new Map(existing.map((s) => [s.key, s.every]));

  // Only touch what differs: re-upserting an unchanged scheduler every 30 s
  // would be churn for no benefit.
  for (const plan of plans) {
    if (scheduled.get(plan.id) !== plan.everyMs) await scheduleFor(queue, plan);
  }

  let removed = 0;
  for (const s of existing) {
    const id = s.key;
    if (id.startsWith('rp-') && !wanted.has(id)) {
      await queue.removeJobScheduler(id);
      removed += 1;
    }
  }
  if (removed > 0) log.info({ active: plans.length, removed }, 'recurring-buy schedules synced');
}

const data = z.object({ planId: z.string().regex(/^rp-[0-9a-f-]{36}$/) });

export function startDcaWorker(pool: pg.Pool, redis: RedisConfig, log: Logger): Worker {
  const worker = new Worker(
    'dca',
    async (job) => {
      const { planId } = data.parse(job.data);
      const at = scheduledAt(job);
      const outcome = await firePlan(pool, planId, at);
      if (outcome.status === 'retry_later') {
        // Throwing hands it back to BullMQ's backoff; the next attempt either
        // finds the other worker's answer or a released stale claim.
        throw new Error('recurring buy is being fired elsewhere; retrying');
      }
      jobOutcomes.inc({ queue: 'dca', outcome: outcome.status === 'noop' ? 'noop' : 'completed' });
      return outcome.status === 'filled' || outcome.status === 'partial'
        ? {
            status: outcome.status,
            quantity: outcome.quantity.toString(),
            notional: outcome.notional.toString(),
          }
        : outcome;
    },
    {
      connection: createRedis(redis.url, 'daftar-worker-dca'),
      prefix: redis.prefix,
      concurrency: 4,
    },
  );
  worker.on('failed', (job, err) => {
    jobOutcomes.inc({ queue: 'dca', outcome: 'failed' });
    log.warn({ job: job?.id, err }, 'recurring buy job failed');
  });
  return worker;
}
