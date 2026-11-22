import { z } from 'zod';
import { formatCash, formatQuantity } from '@daftar/money';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { timed } from '../plugins/request-context.ts';
import { CashAmountOut } from '../contracts/money.ts';
import { getMarket } from '../exchange/queries.ts';
import { averageEntryPrice, markValue, readPosition } from '../exchange/positions.ts';
import { equitySeries } from '../jobs/equity.ts';
import { ErrorOut, QuantityOut, SymbolQuery, UNAUTHENTICATED, authenticate } from './exchange.ts';

/**
 * # Portfolio read models
 *
 * Both endpoints read **projections** — tables written by event-log
 * consumers, not by the request path — and say how fresh they are, because a
 * projection can be behind. The balances on `/v1/exchange/me` come from the
 * ledger and are never behind; these figures can be, and the screen shows
 * `asOf` so a stale number is never presented as a live one.
 */

const EquityRange = z.object({
  range: z.enum(['1d', '7d', '30d']).default('7d'),
});

const RANGE_MS = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;

export const portfolioRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: 'GET',
    url: '/v1/exchange/position',
    schema: {
      tags: ['exchange'],
      summary:
        'Average entry price and profit and loss for one market, from the positions projection.',
      description:
        'Average cost method. `realisedPnl` is fixed by sells already made; `unrealisedPnl` ' +
        'marks what is still held at the last trade price. Built from the event log, so it can ' +
        'lag the ledger: `asOf` is when it last changed and `lastEventId` the newest fill applied.',
      querystring: SymbolQuery,
      response: {
        200: z.object({
          symbol: z.string(),
          quantity: QuantityOut,
          costBasis: CashAmountOut,
          averageEntryPrice: CashAmountOut.nullable(),
          lastPrice: CashAmountOut,
          marketValue: CashAmountOut,
          realisedPnl: CashAmountOut,
          unrealisedPnl: CashAmountOut,
          buys: z.number().int(),
          sells: z.number().int(),
          lastEventId: z.string().nullable(),
          asOf: z.string().nullable(),
        }),
        401: ErrorOut,
        404: ErrorOut,
      },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }
      const { symbol } = request.query;

      const [position, market] = await timed(request, () =>
        Promise.all([readPosition(app.pool, participant.id, symbol), getMarket(app.pool, symbol)]),
      );
      if (!market) {
        reply.status(404);
        return { error: 'unknown_market', message: `no market ${symbol}` };
      }

      const quantity = position?.quantity ?? 0n;
      const costBasis = position?.costBasis ?? 0n;
      const value = markValue(quantity, market.lastPrice);
      const avg = averageEntryPrice({ quantity, costBasis });

      return {
        symbol,
        quantity: formatQuantity(quantity),
        costBasis: formatCash(costBasis),
        averageEntryPrice: avg === null ? null : formatCash(avg),
        lastPrice: formatCash(market.lastPrice),
        marketValue: formatCash(value),
        realisedPnl: formatCash(position?.realisedPnl ?? 0n),
        unrealisedPnl: formatCash(value - costBasis),
        buys: position?.buys ?? 0,
        sells: position?.sells ?? 0,
        lastEventId: position ? position.lastEventId.toString() : null,
        asOf: position?.updatedAt ?? null,
      };
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/exchange/equity',
    schema: {
      tags: ['exchange'],
      summary: 'Equity over time: periodic snapshots of cash plus holdings at the last price.',
      description:
        'One point per snapshot slot (5 minutes by default). Slots missed while the snapshot ' +
        'worker was down are absent, not interpolated. `netContributed` is plotted alongside, ' +
        'so the gap between the two lines is profit or loss.',
      querystring: EquityRange,
      response: {
        200: z.object({
          points: z.array(
            z.object({
              at: z.string(),
              equity: CashAmountOut,
              netContributed: CashAmountOut,
            }),
          ),
        }),
        401: ErrorOut,
      },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }
      const since = new Date(Date.now() - RANGE_MS[request.query.range]);
      const points = await timed(request, () => equitySeries(app.pool, participant.id, since));
      return {
        points: points.map((p) => ({
          at: p.at,
          equity: formatCash(p.equity),
          netContributed: formatCash(p.netContributed),
        })),
      };
    },
  });
};
