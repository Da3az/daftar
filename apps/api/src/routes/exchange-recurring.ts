import { z } from 'zod';
import { divRound, formatCash, formatQuantity } from '@daftar/money';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { timed } from '../plugins/request-context.ts';
import { CashAmountOut, PositiveCashAmount } from '../contracts/money.ts';
import { DEFAULT_MARKET } from '../exchange/engine.ts';
import {
  CADENCES,
  averagePaid,
  createPlan,
  listPlans,
  listRuns,
  setPlanStatus,
  type Plan,
} from '../exchange/recurring.ts';
import { ErrorOut, QuantityOut, UNAUTHENTICATED, authenticate } from './exchange.ts';

/**
 * # Recurring buys, for the guest
 *
 * The API writes only `recurring_plans`. The worker process turns active plans
 * into BullMQ Job Schedulers within 30 s (see `jobs/dca.ts`), so a new or
 * resumed plan's first run is up to one sync plus one interval away, and a
 * paused plan never buys again even if its scheduler fires once more — every
 * firing re-reads the plan.
 */

const MAX_PLANS = 5;
const CASH_RATE_MAX = 30;

const RunOut = z.object({
  scheduledFor: z.string(),
  status: z.enum(['filled', 'partial', 'skipped']),
  quantity: QuantityOut.nullable(),
  notional: CashAmountOut.nullable(),
  reason: z.string().nullable(),
});

const PlanOut = z.object({
  id: z.string(),
  symbol: z.string(),
  amount: CashAmountOut,
  cadence: z.enum(['1m', '1h', '1d', '1w']).nullable(),
  everyMs: z.number().int(),
  status: z.enum(['active', 'paused']),
  /**
   * When the next run is due, if active: the last run's scheduled time plus
   * the interval. BullMQ offsets each scheduler from the epoch by its creation
   * time (seen as `offset` on the scheduler in Valkey), which the API does not
   * read, so before the first run this is null — the first run is taken within
   * one schedule sync (30 s) of creating or resuming the plan.
   */
  nextRunAt: z.string().nullable(),
  bought: QuantityOut,
  spent: CashAmountOut,
  averagePrice: CashAmountOut.nullable(),
  runs: z.array(RunOut),
  createdAt: z.string(),
});

const cadenceOf = (everyMs: number) =>
  (Object.entries(CADENCES).find(([, ms]) => ms === everyMs)?.[0] ?? null) as
    keyof typeof CADENCES | null;

export const recurringRoutes: FastifyPluginAsyncZod = async (app) => {
  const describe = async (plans: Plan[]) => {
    const ids = plans.map((p) => p.id);
    const [runs, totals] = await Promise.all([listRuns(app.pool, ids), averagePaid(app.pool, ids)]);
    const now = Date.now();
    return plans
      .filter((p) => p.status !== 'deleted')
      .map((p) => {
        const t = totals.get(p.id) ?? { quantity: 0n, notional: 0n };
        return {
          id: p.id,
          symbol: p.symbol,
          amount: formatCash(p.amount),
          cadence: cadenceOf(p.everyMs),
          everyMs: p.everyMs,
          status: p.status as 'active' | 'paused',
          nextRunAt: (() => {
            const last = runs.get(p.id)?.[0];
            if (p.status !== 'active' || !last) return null;
            let next = Date.parse(last.scheduledFor) + p.everyMs;
            while (next < now) next += p.everyMs;
            return new Date(next).toISOString();
          })(),
          bought: formatQuantity(t.quantity),
          spent: formatCash(t.notional),
          averagePrice:
            t.quantity > 0n ? formatCash(divRound(t.notional * 100_000_000n, t.quantity)) : null,
          runs: (runs.get(p.id) ?? []).map((r) => ({
            scheduledFor: r.scheduledFor,
            status: r.status,
            quantity: r.quantity === null ? null : formatQuantity(r.quantity),
            notional: r.notional === null ? null : formatCash(r.notional),
            reason: r.reason,
          })),
          createdAt: p.createdAt,
        };
      });
  };

  app.route({
    method: 'GET',
    url: '/v1/exchange/recurring',
    schema: {
      tags: ['exchange'],
      summary: "The session's recurring buys, with run history and average price paid.",
      response: { 200: z.object({ plans: z.array(PlanOut) }), 401: ErrorOut },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }
      const plans = await timed(request, () => listPlans(app.pool, participant.id));
      return { plans: await timed(request, () => describe(plans)) };
    },
  });

  app.route({
    method: 'POST',
    url: '/v1/exchange/recurring',
    config: { rateLimit: { max: CASH_RATE_MAX, timeWindow: 60_000 } },
    schema: {
      tags: ['exchange'],
      summary: 'Start a recurring buy: spend a fixed amount of cash at a fixed cadence.',
      description:
        'Each run is a market buy sized to spend at most `amount` at the prices on the book when ' +
        'it fires, placed through the normal order path with an idempotency key of plan id + ' +
        'scheduled time. A run that cannot be paid for is recorded as skipped and notified.',
      body: z
        .object({
          amount: PositiveCashAmount,
          cadence: z.enum(['1m', '1h', '1d', '1w']),
        })
        .strict(),
      response: { 201: z.object({ plan: PlanOut }), 401: ErrorOut, 422: ErrorOut },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }
      const existing = await listPlans(app.pool, participant.id);
      if (existing.length >= MAX_PLANS) {
        reply.status(422);
        return { error: 'too_many_plans', message: `at most ${String(MAX_PLANS)} recurring buys` };
      }
      if (request.body.amount > 100_000_000n) {
        reply.status(422);
        return { error: 'amount_too_large', message: 'at most 1,000,000.00 per run' };
      }
      const plan = await timed(request, () =>
        createPlan(app.pool, {
          participantId: participant.id,
          symbol: DEFAULT_MARKET,
          amount: request.body.amount,
          everyMs: CADENCES[request.body.cadence],
        }),
      );
      reply.status(201);
      return { plan: (await describe([plan]))[0]! };
    },
  });

  const Params = z.object({ id: z.string().regex(/^rp-[0-9a-f-]{36}$/) });

  for (const [action, status] of [
    ['pause', 'paused'],
    ['resume', 'active'],
  ] as const) {
    app.route({
      method: 'POST',
      url: `/v1/exchange/recurring/:id/${action}`,
      schema: {
        tags: ['exchange'],
        summary: action === 'pause' ? 'Pause a recurring buy.' : 'Resume a paused recurring buy.',
        params: Params,
        response: { 200: z.object({ plan: PlanOut }), 401: ErrorOut, 404: ErrorOut },
      },
      handler: async (request, reply) => {
        const participant = await authenticate(app.pool, request);
        if (!participant) {
          reply.status(401);
          return UNAUTHENTICATED;
        }
        const plan = await setPlanStatus(app.pool, participant.id, request.params.id, status);
        if (!plan) {
          reply.status(404);
          return { error: 'unknown_plan', message: 'no such recurring buy' };
        }
        return { plan: (await describe([plan]))[0]! };
      },
    });
  }

  app.route({
    method: 'DELETE',
    url: '/v1/exchange/recurring/:id',
    schema: {
      tags: ['exchange'],
      summary: 'Delete a recurring buy. Its run history is kept.',
      params: Params,
      response: { 200: z.object({ status: z.literal('deleted') }), 401: ErrorOut, 404: ErrorOut },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }
      const plan = await setPlanStatus(app.pool, participant.id, request.params.id, 'deleted');
      if (!plan) {
        reply.status(404);
        return { error: 'unknown_plan', message: 'no such recurring buy' };
      }
      return { status: 'deleted' as const };
    },
  });
};
