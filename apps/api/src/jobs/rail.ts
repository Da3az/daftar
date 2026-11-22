import { Worker, type Job, type Queue } from 'bullmq';
import type { Logger } from 'pino';
import type pg from 'pg';
import { z } from 'zod';
import type { Envelope } from '../events/envelope.ts';
import { paymentStatus, RailTimeoutError, submitPayment } from '../exchange/rail.ts';
import {
  getWithdrawal,
  markSubmitted,
  noteRailStatus,
  release,
  requeue,
  settle,
  toReview,
} from '../exchange/withdrawals.ts';
import { jobOutcomes } from '../observability/metrics.ts';
import { createRedis, jobId, type Queues, type RedisConfig } from './queues.ts';

/**
 * # The rail jobs
 *
 * ## From the event log to the queue — and why that hop is safe
 *
 * The dispatcher consumes withdrawal events and adds a `rail.submit` job. A
 * Kafka offset commit and a BullMQ `add()` cannot be one atomic step, so the
 * order is fixed: **add, then commit**. A crash between the two redelivers the
 * event, and the add is repeated with the same job id —
 * `<eventId>-submit` — which BullMQ ignores while the first job is still
 * retained (a day; see `queues.ts`). If it has gone, the job runs again and
 * finds the withdrawal no longer `held`: a no-op. The id is an optimisation;
 * the state check is the guarantee.
 *
 * ## `rail.submit`: mark, then call, then record
 *
 *   tx1  held → submitted, attempt counted, committed
 *   call the rail with the withdrawal's fixed reference — no transaction open
 *   record the answer: accepted / unknown → schedule a poll; rejected → release
 *
 * Marking *before* the call is what makes a crash survivable. Die after tx1
 * and before the call, and the withdrawal is `submitted` with nothing at the
 * rail; the poll then finds `not_found` and puts it back to `held`. Die after
 * the call, and the poll finds the payment. Either way the next step is
 * decided by asking the rail, never by guessing.
 *
 * ## `rail.poll`: ask until there is an answer, then stop asking
 *
 * Delayed jobs with growing gaps. Past `RAIL_POLL_DEADLINE_MS` a still-pending
 * payment goes to review: a human is the right answer to a bank that will not
 * say yes or no.
 */

export const isWithdrawalDispatchEvent = (type: string): boolean =>
  type === 'withdrawal.held' || type === 'withdrawal.approved' || type === 'withdrawal.requeued';

const dispatchPayload = z.object({ withdrawalId: z.string().regex(/^[0-9]{1,19}$/) });

/** Side-effect consumer handler: add the job, and only then may the offset move. */
export const dispatchWithdrawal =
  (queue: Queue) =>
  async (event: Envelope): Promise<void> => {
    const { withdrawalId } = dispatchPayload.parse(event.payload);
    await queue.add('rail.submit', { withdrawalId }, { jobId: jobId(event.eventId, 'submit') });
  };

export interface RailJobOptions {
  pollDeadlineMs: number;
  submitRatePerSecond: number;
}

const MAX_SUBMITS = 5;
const POLL_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

const pollDelay = (n: number): number => POLL_DELAYS_MS[Math.min(n, POLL_DELAYS_MS.length - 1)]!;

async function schedulePoll(queue: Queue, withdrawalId: bigint, n: number, attempt: number) {
  await queue.add(
    'rail.poll',
    { withdrawalId: withdrawalId.toString(), n },
    { jobId: jobId('w', withdrawalId, 'a', attempt, 'poll', n), delay: pollDelay(n) },
  );
}

const jobData = z.object({
  withdrawalId: z.string().regex(/^[0-9]{1,19}$/),
  n: z.number().int().min(0).optional(),
});

async function runSubmit(pool: pg.Pool, queue: Queue, job: Job): Promise<string> {
  const id = BigInt(jobData.parse(job.data).withdrawalId);

  const before = await getWithdrawal(pool, id);
  if (!before || before.state !== 'held') return 'noop';
  if (before.submitAttempts >= MAX_SUBMITS) {
    await release(
      pool,
      id,
      `rail never acknowledged after ${String(MAX_SUBMITS)} submissions`,
      'rail.submit',
    );
    return 'released';
  }

  const w = await markSubmitted(pool, id);
  if (!w) return 'noop'; // another run got there first

  const attempt = before.submitAttempts + 1;
  try {
    const outcome = await submitPayment(pool, { reference: w.railReference, amount: w.amount });
    await noteRailStatus(pool, id, outcome);
    if (outcome === 'rejected') {
      await release(pool, id, 'rejected by the rail', 'rail.submit');
      return 'rejected';
    }
  } catch (err) {
    if (!(err instanceof RailTimeoutError)) throw err;
    // Unknown outcome. Do not resubmit on a guess; ask.
    await noteRailStatus(pool, id, 'timeout');
  }

  await schedulePoll(queue, id, 0, attempt);
  return 'submitted';
}

async function runPoll(
  pool: pg.Pool,
  queue: Queue,
  job: Job,
  options: RailJobOptions,
): Promise<string> {
  const data = jobData.parse(job.data);
  const id = BigInt(data.withdrawalId);
  const n = data.n ?? 0;

  const w = await getWithdrawal(pool, id);
  if (!w || w.state !== 'submitted') return 'noop';

  const status = await paymentStatus(pool, w.railReference);
  await noteRailStatus(pool, id, status);

  switch (status) {
    case 'confirmed':
      return (await settle(pool, id)) === 'done' ? 'confirmed' : 'noop';
    case 'rejected':
      await release(pool, id, 'rejected by the rail', 'rail.poll');
      return 'rejected';
    case 'not_found':
      // The submission never arrived (dropped, or we died before sending).
      await requeue(pool, id, 'rail has no record of the payment; resubmitting');
      return 'requeued';
    case 'pending': {
      const since = Date.parse(w.submittedAt ?? w.updatedAt);
      if (Date.now() - since > options.pollDeadlineMs) {
        await toReview(pool, id, 'rail_unconfirmed', 'rail.poll');
        return 'review';
      }
      await schedulePoll(queue, id, n + 1, w.submitAttempts);
      return 'pending';
    }
  }
}

export function startRailWorker(
  pool: pg.Pool,
  queues: Queues,
  redis: RedisConfig,
  options: RailJobOptions,
  log: Logger,
): Worker {
  const worker = new Worker(
    'rail',
    async (job) => {
      const outcome =
        job.name === 'rail.submit'
          ? await runSubmit(pool, queues.rail, job)
          : job.name === 'rail.poll'
            ? await runPoll(pool, queues.rail, job, options)
            : 'unknown';
      if (outcome === 'unknown') throw new Error(`unknown rail job ${job.name}`);
      jobOutcomes.inc({ queue: 'rail', outcome: outcome === 'noop' ? 'noop' : 'completed' });
      return { outcome };
    },
    {
      connection: createRedis(redis.url, 'daftar-worker-rail'),
      prefix: redis.prefix,
      concurrency: 4,
      // The rail's own rate limit, enforced across every worker by Valkey.
      limiter: { max: options.submitRatePerSecond, duration: 1_000 },
    },
  );
  worker.on('failed', (job, err) => {
    jobOutcomes.inc({ queue: 'rail', outcome: 'failed' });
    log.warn({ job: job?.name, attempts: job?.attemptsMade, err }, 'rail job failed');
  });
  return worker;
}

/* --------------------------------------------------------------- sweeper */

/**
 * # The sweeper — the guarantee, in Postgres
 *
 * Valkey with AOF `everysec` can lose the last second of writes on a crash; a
 * Kafka consumer can be down for an hour. Neither may leave a guest's money on
 * hold forever. Every minute this reads the withdrawals table — the only
 * source of truth for where a withdrawal is — and re-drives anything that has
 * not moved for `STUCK_AFTER`:
 *
 * - `held`      → a `rail.submit` job
 * - `submitted` → a `rail.poll` job
 * - `failed`    → the release that should have followed it
 *
 * Job ids include the minute, so the sweeper adds at most one job per stuck
 * withdrawal per sweep, and the state check in each job makes a redundant one
 * harmless.
 */
const STUCK_AFTER = '2 minutes';

export async function sweepWithdrawals(
  pool: pg.Pool,
  queues: Queues,
  log: Logger,
): Promise<number> {
  const { rows } = await pool.query<{ id: bigint; state: string; submit_attempts: number }>(
    `SELECT id, state, submit_attempts FROM withdrawals
      WHERE state IN ('held', 'submitted', 'failed')
        AND updated_at < now() - $1::interval
      ORDER BY updated_at
      LIMIT 200`,
    [STUCK_AFTER],
  );
  const minute = Math.floor(Date.now() / 60_000);
  for (const r of rows) {
    if (r.state === 'held') {
      await queues.rail.add(
        'rail.submit',
        { withdrawalId: r.id.toString() },
        { jobId: jobId('sweep', r.id, minute, 'submit') },
      );
    } else if (r.state === 'submitted') {
      await queues.rail.add(
        'rail.poll',
        { withdrawalId: r.id.toString(), n: 0 },
        { jobId: jobId('sweep', r.id, minute, 'poll') },
      );
    } else {
      await release(pool, r.id, 'release after an interrupted failure', 'sweeper');
    }
  }
  if (rows.length > 0)
    log.info({ redriven: rows.length }, 'withdrawal sweeper re-drove stuck withdrawals');
  return rows.length;
}
