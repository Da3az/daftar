import { z } from 'zod';
import { formatCash, formatQuantity } from '@daftar/money';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { env } from '../env.ts';
import { timed } from '../plugins/request-context.ts';
import { CashAmountOut, PositiveCashAmount, PositiveQuantity } from '../contracts/money.ts';
import { UNIQUE_VIOLATION, sqlstateOf } from '../ledger/sqlstate.ts';
import { exchangeOrdersTotal, exchangeTradesTotal } from '../observability/metrics.ts';
import { DEFAULT_MARKET, cancelBookOrder, placeBookOrder } from '../exchange/engine.ts';
import { GUEST_STARTING_CASH, createGuest, findParticipant } from '../exchange/participants.ts';
import {
  CANDLE_INTERVALS,
  getBalances,
  getBook,
  getCandles,
  getDayStats,
  getMarket,
  getTape,
  listFills,
  listOrders,
  type OrderView,
} from '../exchange/queries.ts';
import {
  GUEST_COOKIE,
  guestCookie,
  issueGuestToken,
  readCookie,
  verifyGuestToken,
} from '../exchange/session.ts';

/**
 * # The exchange API
 *
 * Unlike every legacy route, **nothing here takes an account id.** Market data
 * is public; everything else acts on the participant the session cookie names.
 * A request body that could say whose money to move is the thing the legacy
 * API's "no authentication" note warns about, and a public order book is where
 * it would stop being a footnote.
 *
 * Amounts follow the house rule: exact decimal strings on the wire, `bigint`
 * inside, formatted by `@daftar/money` on the way out.
 */

/** Orders one IP may place or cancel per minute. Generous for a person. */
const ORDER_RATE_MAX = 120;

const QuantityOut = z
  .string()
  .regex(/^\d+\.\d{8}$/)
  .describe('Asset quantity as an exact decimal string, 8 fractional digits.');

const SymbolQuery = z.object({
  symbol: z.string().min(1).max(16).default(DEFAULT_MARKET),
});

/**
 * The id a client chooses for its own order.
 *
 * Stored as `<participant>:<clientOrderId>`, so the UNIQUE index that makes a
 * double-submit one order is scoped to the participant: one guest cannot
 * reserve another's ids, or learn that an id exists by getting a 409 for it.
 */
const ClientOrderId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be url-safe')
  .describe('Client-chosen order id, unique per participant.')
  .meta({ example: 'web-3f6c2c1e9b7a4d10' });

const storedOrderId = (participantExternalId: string, clientOrderId: string): string =>
  `${participantExternalId}:${clientOrderId}`;

const clientOrderIdOf = (participantExternalId: string, stored: string): string =>
  stored.startsWith(`${participantExternalId}:`)
    ? stored.slice(participantExternalId.length + 1)
    : stored;

const PlaceOrderBody = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('limit'),
      clientOrderId: ClientOrderId,
      side: z.enum(['buy', 'sell']),
      quantity: PositiveQuantity,
      limitPrice: PositiveCashAmount.describe('Price per whole coin. Required for a limit order.'),
    })
    .strict(),
  // `.strict()` so a market order sent with a `limitPrice` is a 400 rather than
  // an order that silently ignores the price its sender thought it had set.
  z
    .object({
      type: z.literal('market'),
      clientOrderId: ClientOrderId,
      side: z.enum(['buy', 'sell']),
      quantity: PositiveQuantity,
    })
    .strict(),
]);

const OrderOut = z.object({
  clientOrderId: z.string(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['limit', 'market']),
  limitPrice: CashAmountOut.nullable(),
  quantity: QuantityOut,
  filledQuantity: QuantityOut,
  status: z.enum(['open', 'filled', 'cancelled']),
  cancelReason: z.string().nullable(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const FillOut = z.object({
  price: CashAmountOut,
  quantity: QuantityOut,
  notional: CashAmountOut,
});

const ParticipantOut = z.object({
  displayName: z.string(),
  kind: z.enum(['guest', 'bot']),
  createdAt: z.string(),
});

const BalancesOut = z.object({
  cash: CashAmountOut,
  cashAvailable: CashAmountOut,
  asset: QuantityOut,
  assetAvailable: QuantityOut,
});

const ErrorOut = z.object({
  error: z.string(),
  message: z.string(),
  unit: z.string().optional(),
  available: z.string().optional(),
  required: z.string().optional(),
});

const UNAUTHENTICATED = {
  error: 'not_a_guest',
  message: 'no guest session; POST /v1/exchange/guest to enter',
} as const;

/** Never negative on the wire: a reservation can briefly exceed a balance. */
const clamp = (value: bigint): bigint => (value < 0n ? 0n : value);

/**
 * The participant the request's cookie names, or `null`.
 *
 * Signature first, database second: until the MAC has vouched for it the id is
 * attacker-chosen, and looking it up would let anyone probe which guest ids
 * exist at one indexed read each.
 */
async function authenticate(pool: pg.Pool, request: FastifyRequest) {
  const token = readCookie(request.headers.cookie, GUEST_COOKIE);
  if (token === null) return null;

  const externalId = verifyGuestToken(env.GUEST_SESSION_SECRET, token);
  if (externalId === null) return null;

  return timed(request, () => findParticipant(pool, externalId));
}

export const exchangeRoutes: FastifyPluginAsyncZod = async (app) => {
  const secure = env.NODE_ENV === 'production';

  const orderOut = (
    participantExternalId: string,
    order: Omit<OrderView, 'createdAt' | 'updatedAt'>,
  ) => ({
    clientOrderId: clientOrderIdOf(participantExternalId, order.externalId),
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    limitPrice: order.limitPrice === null ? null : formatCash(order.limitPrice),
    quantity: formatQuantity(order.quantity),
    filledQuantity: formatQuantity(order.filledQuantity),
    status: order.status,
    cancelReason: order.cancelReason,
  });

  /* ---------------------------------------------------------------- session */

  app.route({
    method: 'POST',
    url: '/v1/exchange/guest',
    config: {
      rateLimit: { max: env.EXCHANGE_GUEST_RATE_MAX, timeWindow: 3_600_000 },
    },
    schema: {
      tags: ['exchange'],
      summary: 'Enter as a guest: create a funded account and a session cookie.',
      description: [
        'Creates a cash account, a position account and a participant, and',
        'credits the starting balance from `external:guest-faucet` — all in one',
        'database transaction, so a guest that exists is a guest that is funded.',
        '',
        'Idempotent for a browser that already holds a valid session: it gets',
        'its existing guest back with a 200 rather than a second account.',
      ].join('\n'),
      response: {
        201: z.object({ participant: ParticipantOut, startingCash: CashAmountOut }),
        200: z.object({ participant: ParticipantOut, startingCash: CashAmountOut }),
      },
    },
    handler: async (request, reply) => {
      const existing = await authenticate(app.pool, request);

      const participant = existing ?? (await timed(request, () => createGuest(app.pool)));

      if (!existing) {
        reply.header(
          'set-cookie',
          guestCookie(issueGuestToken(env.GUEST_SESSION_SECRET, participant.externalId), {
            secure,
          }),
        );
      }

      reply.status(existing ? 200 : 201);
      return {
        participant: {
          displayName: participant.displayName,
          kind: participant.kind,
          createdAt: participant.createdAt,
        },
        startingCash: formatCash(GUEST_STARTING_CASH),
      };
    },
  });

  app.route({
    method: 'POST',
    url: '/v1/exchange/logout',
    schema: {
      tags: ['exchange'],
      summary: 'Forget the guest session on this browser.',
      description:
        'Clears the cookie. The account, its orders and its ledger history remain — ' +
        'entries are append-only — but nothing can reach them once the cookie is gone.',
      response: { 204: z.null() },
    },
    handler: async (_request, reply) => {
      reply.header('set-cookie', guestCookie('', { secure, clear: true }));
      reply.status(204);
      return null;
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/exchange/me',
    schema: {
      tags: ['exchange'],
      summary: "The session's participant, balances and working orders.",
      querystring: SymbolQuery,
      response: {
        200: z.object({
          participant: ParticipantOut,
          symbol: z.string(),
          balances: BalancesOut,
          openOrders: z.array(OrderOut),
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

      const { symbol } = request.query;

      const [balances, openOrders] = await timed(request, () =>
        Promise.all([
          getBalances(app.pool, participant, symbol),
          listOrders(app.pool, participant.id, { openOnly: true, limit: 100 }),
        ]),
      );

      return {
        participant: {
          displayName: participant.displayName,
          kind: participant.kind,
          createdAt: participant.createdAt,
        },
        symbol,
        balances: {
          cash: formatCash(balances.cash),
          cashAvailable: formatCash(clamp(balances.cashAvailable)),
          asset: formatQuantity(balances.asset),
          assetAvailable: formatQuantity(clamp(balances.assetAvailable)),
        },
        openOrders: openOrders.map((o) => ({
          ...orderOut(participant.externalId, o),
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
        })),
      };
    },
  });

  /* ------------------------------------------------------------ market data */

  app.route({
    method: 'GET',
    url: '/v1/exchange/market',
    schema: {
      tags: ['exchange'],
      summary: 'One market: rules, last price, 24h stats, order book and tape.',
      description:
        'Everything the trading screen redraws on each poll, in one response, so the book ' +
        'and the tape it is shown beside come from reads a few milliseconds apart rather ' +
        'than from three independently-timed requests.',
      querystring: SymbolQuery.extend({
        depth: z.coerce.number().int().min(1).max(50).default(15),
        tape: z.coerce.number().int().min(1).max(100).default(40),
      }),
      response: {
        200: z.object({
          market: z.object({
            symbol: z.string(),
            displayName: z.string(),
            tickSize: CashAmountOut,
            lotSize: QuantityOut,
            minPrice: CashAmountOut,
            maxPrice: CashAmountOut,
            openingPrice: CashAmountOut,
            lastPrice: CashAmountOut,
            lastTradeAt: z.string().nullable(),
          }),
          stats: z.object({
            open: CashAmountOut.nullable(),
            high: CashAmountOut.nullable(),
            low: CashAmountOut.nullable(),
            volume: QuantityOut,
            trades: z.number().int(),
          }),
          book: z.object({
            bids: z.array(
              z.object({ price: CashAmountOut, quantity: QuantityOut, orders: z.number().int() }),
            ),
            asks: z.array(
              z.object({ price: CashAmountOut, quantity: QuantityOut, orders: z.number().int() }),
            ),
          }),
          tape: z.array(
            z.object({
              id: z.string(),
              price: CashAmountOut,
              quantity: QuantityOut,
              takerSide: z.enum(['buy', 'sell']),
              createdAt: z.string(),
            }),
          ),
        }),
        404: ErrorOut,
      },
    },
    handler: async (request, reply) => {
      const { symbol, depth, tape: tapeLimit } = request.query;

      const [market, stats, book, tape] = await timed(request, () =>
        Promise.all([
          getMarket(app.pool, symbol),
          getDayStats(app.pool, symbol),
          getBook(app.pool, symbol, depth),
          getTape(app.pool, symbol, tapeLimit),
        ]),
      );

      if (!market) {
        reply.status(404);
        return { error: 'unknown_market', message: `no market ${symbol}` };
      }

      const cashOrNull = (value: bigint | null) => (value === null ? null : formatCash(value));
      const level = (l: { price: bigint; quantity: bigint; orders: number }) => ({
        price: formatCash(l.price),
        quantity: formatQuantity(l.quantity),
        orders: l.orders,
      });

      return {
        market: {
          symbol: market.symbol,
          displayName: market.displayName,
          tickSize: formatCash(market.tickSize),
          lotSize: formatQuantity(market.lotSize),
          minPrice: formatCash(market.minPrice),
          maxPrice: formatCash(market.maxPrice),
          openingPrice: formatCash(market.openingPrice),
          lastPrice: formatCash(market.lastPrice),
          lastTradeAt: market.lastTradeAt,
        },
        stats: {
          open: cashOrNull(stats.open),
          high: cashOrNull(stats.high),
          low: cashOrNull(stats.low),
          volume: formatQuantity(stats.volume),
          trades: stats.trades,
        },
        book: { bids: book.bids.map(level), asks: book.asks.map(level) },
        tape: tape.map((t) => ({
          id: t.id.toString(),
          price: formatCash(t.price),
          quantity: formatQuantity(t.quantity),
          takerSide: t.takerSide,
          createdAt: t.createdAt,
        })),
      };
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/exchange/candles',
    schema: {
      tags: ['exchange'],
      summary: 'OHLC candles, aggregated from trades on read.',
      querystring: SymbolQuery.extend({
        interval: z.enum(['1m', '5m', '1h']).default('1m'),
        limit: z.coerce.number().int().min(1).max(500).default(240),
      }),
      response: {
        200: z.object({
          interval: z.enum(['1m', '5m', '1h']),
          intervalSeconds: z.number().int(),
          candles: z.array(
            z.object({
              time: z.number().int().describe('Bucket start, Unix seconds.'),
              open: CashAmountOut,
              high: CashAmountOut,
              low: CashAmountOut,
              close: CashAmountOut,
              volume: QuantityOut,
            }),
          ),
        }),
      },
    },
    handler: async (request) => {
      const { symbol, interval, limit } = request.query;
      const candles = await timed(request, () => getCandles(app.pool, symbol, interval, limit));

      return {
        interval,
        intervalSeconds: CANDLE_INTERVALS[interval],
        candles: candles.map((c) => ({
          time: c.time,
          open: formatCash(c.open),
          high: formatCash(c.high),
          low: formatCash(c.low),
          close: formatCash(c.close),
          volume: formatQuantity(c.volume),
        })),
      };
    },
  });

  /* ----------------------------------------------------------------- orders */

  app.route({
    method: 'POST',
    url: '/v1/exchange/orders',
    config: { rateLimit: { max: ORDER_RATE_MAX, timeWindow: 60_000 } },
    schema: {
      tags: ['exchange'],
      summary: 'Place a limit or market order on the book.',
      description: [
        'The order is matched against resting orders at once, best price first',
        'and oldest first within a price. Each fill is one four-leg ledger',
        'transaction, and the order row, every trade and every entry commit',
        'together or not at all.',
        '',
        'A **limit** order rests with whatever is left unfilled. A **market**',
        'order never rests: the unfilled remainder is cancelled',
        '(immediate-or-cancel), and one that fills nothing at all is refused',
        'with `no_liquidity` and leaves no row.',
        '',
        'A fill is priced at the *resting* order’s limit price. The `symbol` is',
        'a query parameter; the account is the session’s and cannot be named.',
      ].join('\n'),
      querystring: SymbolQuery,
      body: PlaceOrderBody,
      response: {
        201: z.object({ order: OrderOut, fills: z.array(FillOut) }),
        401: ErrorOut,
        404: ErrorOut,
        409: ErrorOut,
        422: ErrorOut,
      },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }

      const body = request.body;
      const { symbol } = request.query;

      const count = (outcome: string): void => {
        exchangeOrdersTotal.inc({
          actor: participant.kind,
          side: body.side,
          type: body.type,
          outcome,
        });
      };

      try {
        const result = await timed(request, () =>
          placeBookOrder(app.pool, {
            externalId: storedOrderId(participant.externalId, body.clientOrderId),
            participantExternalId: participant.externalId,
            symbol,
            side: body.side,
            type: body.type,
            quantity: body.quantity,
            ...(body.type === 'limit' ? { limitPrice: body.limitPrice } : {}),
          }),
        );

        count(result.status);

        switch (result.status) {
          case 'accepted':
            if (result.fills.length > 0) {
              exchangeTradesTotal.inc({ taker_side: body.side }, result.fills.length);
            }

            reply.status(201);
            return {
              order: orderOut(participant.externalId, result.order),
              fills: result.fills.map((f) => ({
                price: formatCash(f.price),
                quantity: formatQuantity(f.quantity),
                notional: formatCash(f.notional),
              })),
            };

          case 'unknown_market':
            reply.status(404);
            return { error: 'unknown_market', message: `no market ${symbol}` };

          case 'unknown_participant':
            reply.status(401);
            return UNAUTHENTICATED;

          case 'invalid_quantity':
            reply.status(422);
            return {
              error: 'invalid_quantity',
              message:
                `quantity must be a multiple of ${formatQuantity(result.lotSize)} ` +
                `and at most ${formatQuantity(result.maxQuantity)}`,
            };

          case 'invalid_price':
            reply.status(422);
            return {
              error: 'invalid_price',
              message:
                `limit price must be a multiple of ${formatCash(result.tickSize)} between ` +
                `${formatCash(result.minPrice)} and ${formatCash(result.maxPrice)}`,
            };

          case 'insufficient_funds': {
            const cash = result.unit === 'USD';
            const format = cash ? formatCash : formatQuantity;
            reply.status(422);
            return {
              error: 'insufficient_funds',
              message: cash
                ? 'not enough available cash; open buy orders reserve theirs'
                : `not enough available ${result.unit}; open sell orders reserve theirs`,
              unit: result.unit,
              available: format(clamp(result.available)),
              required: format(result.required),
            };
          }

          case 'too_many_open_orders':
            reply.status(422);
            return {
              error: 'too_many_open_orders',
              message: `at most ${String(result.limit)} open orders; cancel one first`,
            };

          case 'no_liquidity':
            reply.status(422);
            return {
              error: 'no_liquidity',
              message: 'nothing is resting on the other side of the book',
            };
        }
      } catch (err) {
        const code = sqlstateOf(err);
        request.ctx.sqlstate = code ?? null;

        // `book_orders_external_id_key` decided this, not a prior SELECT.
        if (code === UNIQUE_VIOLATION) {
          count('duplicate');
          reply.status(409);
          return {
            error: 'duplicate_order',
            message: `order ${body.clientOrderId} already exists`,
          };
        }
        throw err;
      }
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/exchange/orders',
    schema: {
      tags: ['exchange'],
      summary: "The session's orders, newest first.",
      querystring: z.object({
        status: z.enum(['open', 'all']).default('all'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      response: { 200: z.object({ orders: z.array(OrderOut) }), 401: ErrorOut },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }

      const orders = await timed(request, () =>
        listOrders(app.pool, participant.id, {
          openOnly: request.query.status === 'open',
          limit: request.query.limit,
        }),
      );

      return {
        orders: orders.map((o) => ({
          ...orderOut(participant.externalId, o),
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
        })),
      };
    },
  });

  app.route({
    method: 'DELETE',
    url: '/v1/exchange/orders/:clientOrderId',
    config: { rateLimit: { max: ORDER_RATE_MAX, timeWindow: 60_000 } },
    schema: {
      tags: ['exchange'],
      summary: 'Cancel one of the session’s open orders.',
      params: z.object({ clientOrderId: ClientOrderId }),
      response: {
        200: z.object({ status: z.literal('cancelled') }),
        401: ErrorOut,
        404: ErrorOut,
        409: ErrorOut,
      },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }

      const { clientOrderId } = request.params;

      const result = await timed(request, () =>
        cancelBookOrder(app.pool, {
          participantExternalId: participant.externalId,
          orderExternalId: storedOrderId(participant.externalId, clientOrderId),
        }),
      );

      switch (result.status) {
        case 'cancelled':
          return { status: 'cancelled' as const };

        case 'not_found':
          reply.status(404);
          return { error: 'unknown_order', message: `no order ${clientOrderId}` };

        case 'not_open':
          // 409: the order exists and is the caller's, but the race was lost —
          // it filled, or was already cancelled, before this arrived.
          reply.status(409);
          return {
            error: 'order_not_open',
            message: `order ${clientOrderId} is already ${result.current}`,
          };
      }
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/exchange/fills',
    schema: {
      tags: ['exchange'],
      summary: "The session's trades, from either side of the book, newest first.",
      querystring: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      response: {
        200: z.object({
          fills: z.array(
            FillOut.extend({
              tradeId: z.string(),
              clientOrderId: z.string(),
              symbol: z.string(),
              side: z.enum(['buy', 'sell']),
              liquidity: z.enum(['maker', 'taker']),
              createdAt: z.string(),
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

      const fills = await timed(request, () =>
        listFills(app.pool, participant.id, request.query.limit),
      );

      return {
        fills: fills.map((f) => ({
          tradeId: f.tradeId.toString(),
          clientOrderId: clientOrderIdOf(participant.externalId, f.orderExternalId),
          symbol: f.symbol,
          side: f.side,
          liquidity: f.liquidity,
          price: formatCash(f.price),
          quantity: formatQuantity(f.quantity),
          notional: formatCash(f.notional),
          createdAt: f.createdAt,
        })),
      };
    },
  });
};
