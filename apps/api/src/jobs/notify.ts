import { formatCash, formatQuantity } from '@daftar/money';
import { Worker, type Queue } from 'bullmq';
import type { Logger } from 'pino';
import type pg from 'pg';
import { z } from 'zod';
import type { Envelope } from '../events/envelope.ts';
import type { StringProducer } from '../events/kafka.ts';
import { jobOutcomes } from '../observability/metrics.ts';
import { createRedis, jobId, type RedisConfig } from './queues.ts';

/**
 * # Notifications
 *
 * event log → notifier consumer → `notify` job → `notifications` row → a
 * "written" message on the notifications topic → API instances push it.
 *
 * Every arrow is at-least-once, and the row's `UNIQUE (event_id, kind)` is
 * what makes the guest see one notification per event regardless. The final
 * push is best-effort on purpose: a client that misses it reads the list on
 * its next poll or reconnect, so losing a push loses latency, never a
 * notification.
 */

const NOTIFIABLE = new Set([
  'trade.buy',
  'trade.sell',
  'deposit.credited',
  'transfer.received',
  'withdrawal.review',
  'withdrawal.confirmed',
  'withdrawal.released',
  'dca.skipped',
  'dca.filled',
]);

export const isNotifiable = (type: string): boolean => NOTIFIABLE.has(type);

export interface NotifyJob {
  eventId: string;
  type: string;
  accountId: string;
  occurredAt: string;
  payload: unknown;
}

export const enqueueNotification =
  (queue: Queue) =>
  async (event: Envelope): Promise<void> => {
    const data: NotifyJob = {
      eventId: event.eventId.toString(),
      type: event.type,
      accountId: event.accountId.toString(),
      occurredAt: event.occurredAt,
      payload: event.payload,
    };
    await queue.add('notify', data, { jobId: jobId(event.eventId, 'notify') });
  };

const p = z
  .object({
    amount: z.string().optional(),
    notional: z.string().optional(),
    quantity: z.string().optional(),
    price: z.string().optional(),
    symbol: z.string().optional(),
    counterparty: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

const cash = (v: string | undefined) => (v && /^-?[0-9]+$/.test(v) ? formatCash(BigInt(v)) : '—');
const qty = (v: string | undefined) => (v && /^[0-9]+$/.test(v) ? formatQuantity(BigInt(v)) : '—');

/** One sentence per kind. Never carries an id, a handle or a session subject. */
export function render(type: string, payload: unknown): { title: string; body: string | null } {
  const parsed = p.safeParse(payload);
  const x: z.infer<typeof p> = parsed.success ? parsed.data : {};
  switch (type) {
    case 'trade.buy':
      return {
        title: `Bought ${qty(x.quantity)} ${x.symbol ?? ''} at ${cash(x.price)}`.trim(),
        body: null,
      };
    case 'trade.sell':
      return {
        title: `Sold ${qty(x.quantity)} ${x.symbol ?? ''} at ${cash(x.price)}`.trim(),
        body: null,
      };
    case 'deposit.credited':
      return { title: `Deposit of ${cash(x.amount)} credited`, body: null };
    case 'transfer.received':
      return {
        title: `${cash(x.amount)} received`,
        body: x.counterparty ? `from ${x.counterparty}` : null,
      };
    case 'withdrawal.review':
      return { title: `Withdrawal of ${cash(x.amount)} is waiting for a review`, body: null };
    case 'withdrawal.confirmed':
      return { title: `Withdrawal of ${cash(x.amount)} paid out`, body: null };
    case 'withdrawal.released':
      return {
        title: `Withdrawal of ${cash(x.amount)} returned to your cash`,
        body: x.reason ?? null,
      };
    case 'dca.skipped':
      return { title: 'A recurring buy was skipped', body: x.reason ?? null };
    case 'dca.filled':
      return { title: `Recurring buy: ${qty(x.quantity)} for ${cash(x.notional)}`, body: null };
    default:
      return { title: type, body: null };
  }
}

const jobData = z.object({
  eventId: z.string().regex(/^[0-9]{1,19}$/),
  type: z.string(),
  accountId: z.string().regex(/^[0-9]{1,19}$/),
  occurredAt: z.string(),
  payload: z.unknown(),
});

export function startNotifyWorker(
  pool: pg.Pool,
  producer: StringProducer,
  notificationsTopic: string,
  redis: RedisConfig,
  log: Logger,
): Worker {
  const worker = new Worker(
    'notify',
    async (job) => {
      const data = jobData.parse(job.data);
      const { title, body } = render(data.type, data.payload);

      const { rows } = await pool.query<{ id: bigint; participant_id: bigint }>(
        `INSERT INTO notifications (participant_id, event_id, kind, title, body, occurred_at)
         SELECT p.id, $2::bigint, $3, $4, $5, $6::timestamptz
           FROM participants p WHERE p.cash_account_id = $1::bigint
         ON CONFLICT (event_id, kind) DO NOTHING
         RETURNING id, participant_id`,
        [data.accountId, data.eventId, data.type, title, body, data.occurredAt],
      );
      const row = rows[0];
      if (!row) {
        jobOutcomes.inc({ queue: 'notify', outcome: 'noop' });
        return { outcome: 'duplicate' };
      }

      // Best-effort: the row is the notification; this only makes it instant.
      try {
        await producer.send({
          messages: [
            {
              topic: notificationsTopic,
              key: data.accountId,
              value: JSON.stringify({
                id: row.id.toString(),
                accountId: data.accountId,
                eventId: data.eventId,
                kind: data.type,
                title,
                body,
                occurredAt: data.occurredAt,
              }),
            },
          ],
        });
      } catch (err) {
        log.warn({ err }, 'notification push failed; it will be read on the next poll');
      }
      jobOutcomes.inc({ queue: 'notify', outcome: 'completed' });
      return { outcome: 'written' };
    },
    {
      connection: createRedis(redis.url, 'daftar-worker-notify'),
      prefix: redis.prefix,
      concurrency: 8,
    },
  );
  worker.on('failed', (job, err) => {
    jobOutcomes.inc({ queue: 'notify', outcome: 'failed' });
    log.warn({ job: job?.id, err }, 'notify job failed');
  });
  return worker;
}
