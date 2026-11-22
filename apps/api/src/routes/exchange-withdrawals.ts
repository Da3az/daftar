import { z } from 'zod';
import { formatCash } from '@daftar/money';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { timed } from '../plugins/request-context.ts';
import { CashAmountOut } from '../contracts/money.ts';
import {
  listWithdrawals,
  transitionsOf,
  type Transition,
  type Withdrawal,
} from '../exchange/withdrawals.ts';
import { ErrorOut, UNAUTHENTICATED, authenticate } from './exchange.ts';

/**
 * # Withdrawal tracking, for the guest
 *
 * Each withdrawal with its full state history — written by a database trigger,
 * so it is complete by construction — and the step a stepper should show.
 * Never exposes the rail reference or any internal account id.
 */

const State = z.enum([
  'requested',
  'held',
  'review',
  'submitted',
  'confirmed',
  'failed',
  'released',
]);

export const WithdrawalOut = z.object({
  id: z.string(),
  clientId: z.string().nullable(),
  amount: CashAmountOut,
  state: State,
  /** 0 requested · 1 on hold · 2 sent · 3 done (confirmed or returned). */
  step: z.number().int().min(0).max(3),
  outcome: z.enum(['in_progress', 'paid_out', 'returned']),
  inReview: z.boolean(),
  submitAttempts: z.number().int(),
  lastRailStatus: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  history: z.array(
    z.object({
      from: State.nullable(),
      to: State,
      reason: z.string().nullable(),
      actor: z.string().nullable(),
      at: z.string(),
    }),
  ),
});

const STEP: Record<Withdrawal['state'], number> = {
  requested: 0,
  held: 1,
  review: 1,
  submitted: 2,
  confirmed: 3,
  failed: 2,
  released: 3,
};

export function withdrawalOut(
  w: Withdrawal,
  history: Transition[],
  participantExternalId: string | null,
): z.infer<typeof WithdrawalOut> {
  const prefix = participantExternalId === null ? null : `${participantExternalId}:`;
  return {
    id: w.id.toString(),
    clientId:
      prefix !== null && w.externalId.startsWith(prefix) ? w.externalId.slice(prefix.length) : null,
    amount: formatCash(w.amount),
    state: w.state,
    step: STEP[w.state],
    outcome:
      w.state === 'confirmed' ? 'paid_out' : w.state === 'released' ? 'returned' : 'in_progress',
    inReview: w.state === 'review',
    submitAttempts: w.submitAttempts,
    lastRailStatus: w.lastRailStatus,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    history,
  };
}

export const withdrawalRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: 'GET',
    url: '/v1/exchange/withdrawals',
    schema: {
      tags: ['exchange'],
      summary: "The session's withdrawals, newest first, each with its state history.",
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
      response: {
        200: z.object({ withdrawals: z.array(WithdrawalOut) }),
        401: ErrorOut,
      },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }
      const list = await timed(request, () =>
        listWithdrawals(app.pool, participant.id, request.query.limit),
      );
      const history = await timed(request, () =>
        transitionsOf(
          app.pool,
          list.map((w) => w.id),
        ),
      );
      return {
        withdrawals: list.map((w) =>
          withdrawalOut(w, history.get(w.id) ?? [], participant.externalId),
        ),
      };
    },
  });
};
