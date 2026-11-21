import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { formatCash, formatQuantity } from '@daftar/money';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { env } from '../env.ts';
import { timed } from '../plugins/request-context.ts';
import { CashAmountOut, PositiveCashAmount, PositiveQuantity } from '../contracts/money.ts';
import { UNIQUE_VIOLATION, sqlstateOf } from '../ledger/sqlstate.ts';
import {
  exchangeOrdersTotal,
  exchangeTradesTotal,
  idempotencyOutcomes,
} from '../observability/metrics.ts';
import { claim, hashRequest, release, settle } from '../idempotency/keys.ts';
import { SIGNATURE_HEADER, SIGNATURE_SCHEME, computeSignature } from '../webhooks/signature.ts';
import {
  DEFAULT_MARKET,
  cancelBookOrder,
  placeBookOrder,
  type BookOrder,
  type Fill,
} from '../exchange/engine.ts';
import {
  MAX_CASH_MOVEMENT,
  ensureFundingAccount,
  listActivity,
  netContributed,
  pendingActivity,
  transfer,
  withdraw,
} from '../exchange/cash.ts';
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

/** Withdrawals and transfers one IP may make per minute. */
const CASH_RATE_MAX = 30;

/** The route name an order's `Idempotency-Key` is scoped to. */
const ORDER_ROUTE = 'POST /v1/exchange/orders';

/** Ceiling on one deposit: 10,000.00 — the size of the opening balance. */
const MAX_DEPOSIT = 1_000_000n;

/**
 * Deposits one guest may make per hour.
 *
 * It is play money, but an unlimited tap makes the opening balance — and so
 * every "insufficient funds" on the screen — meaningless.
 */
const MAX_DEPOSITS_PER_HOUR = 10;

/** How many times the simulated provider may be asked to deliver one event. */
const MAX_DELIVERIES = 10;

/** The simulated provider's re-deliveries after a 409 (Conflict). */
const PROVIDER_RETRIES = 3;
const PROVIDER_RETRY_DELAY_MS = 40;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Client-chosen id for a withdrawal or transfer; same shape as an order's. */
const MovementBody = {
  clientId: ClientOrderId.describe('Client-chosen id for this movement, unique per participant.'),
  amount: PositiveCashAmount,
};

const MovementOut = z.object({
  status: z.literal('completed'),
  amount: CashAmountOut,
  cashBalance: CashAmountOut,
});

const ActivityOut = z.object({
  id: z.string(),
  type: z.string().describe('e.g. `trade.buy`, `deposit.credited`, `transfer.received`.'),
  /** When the money moved. */
  occurredAt: z.string(),
  /** When the outbox worker delivered the event. The gap is the worker's lag. */
  publishedAt: z.string(),
  /** Cash that moved: a trade's notional, or the amount deposited, withdrawn or sent. */
  amount: CashAmountOut.nullable(),
  symbol: z.string().nullable(),
  side: z.enum(['buy', 'sell']).nullable(),
  liquidity: z.enum(['maker', 'taker']).nullable(),
  price: CashAmountOut.nullable(),
  quantity: QuantityOut.nullable(),
  counterparty: z.string().nullable(),
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
          startingCash: CashAmountOut,
          handle: z.string().describe('Public code another guest uses to send this one cash.'),
          netContributed: CashAmountOut.describe(
            'Opening credit plus deposits and transfers in, less withdrawals and transfers ' +
              'out. Profit and loss is equity minus this.',
          ),
          pendingEvents: z
            .number()
            .int()
            .describe('Events committed with this account’s money and not yet in its feed.'),
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

      const [balances, openOrders, contributed, pendingEvents] = await timed(request, () =>
        Promise.all([
          getBalances(app.pool, participant, symbol),
          listOrders(app.pool, participant.id, { openOnly: true, limit: 100 }),
          netContributed(app.pool, participant.cashAccountId),
          pendingActivity(app.pool, participant.cashAccountId),
        ]),
      );

      return {
        participant: {
          displayName: participant.displayName,
          kind: participant.kind,
          createdAt: participant.createdAt,
        },
        symbol,
        startingCash: formatCash(GUEST_STARTING_CASH),
        handle: participant.handle,
        netContributed: formatCash(contributed),
        pendingEvents,
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
        '',
        '**Retries.** Send an `Idempotency-Key` and a repeat of the same request',
        'gets the original answer back — the same order, the same fills — with',
        '200 instead of 201, rather than a second order. The key is claimed by a',
        'UNIQUE index before any matching happens, and for an accepted order its',
        'response is recorded in the matching transaction itself. A repeat that',
        'arrives while the first is still matching gets 409; the same key with a',
        'different body gets 422. Without the header, `clientOrderId` alone still',
        'makes a double submit one order, answered with 409.',
      ].join('\n'),
      querystring: SymbolQuery,
      headers: z.object({
        'idempotency-key': z
          .string()
          .min(8)
          .max(255)
          .optional()
          .describe('Optional. Scoped to the session’s participant.'),
      }),
      body: PlaceOrderBody,
      response: {
        201: z.object({ order: OrderOut, fills: z.array(FillOut) }),
        200: z.object({ order: OrderOut, fills: z.array(FillOut) }),
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
      const idempotencyKey = request.headers['idempotency-key'];

      const count = (outcome: string): void => {
        exchangeOrdersTotal.inc({
          actor: participant.kind,
          side: body.side,
          type: body.type,
          outcome,
        });
      };

      /**
       * Claim the key BEFORE matching, exactly as the legacy order route does:
       * one `INSERT ... ON CONFLICT DO NOTHING` decides who owns this request.
       *
       * Stored as `<participant>:<key>` for the reason `clientOrderId` is — one
       * guest must not be able to occupy another's keys, or read another's
       * recorded response by guessing one.
       */
      let claimedKeyId: bigint | undefined;

      if (idempotencyKey !== undefined) {
        const outcome = await timed(request, () =>
          claim(app.pool, {
            route: ORDER_ROUTE,
            key: `${participant.externalId}:${idempotencyKey}`,
            // The symbol is part of the request even though it travels in the
            // query string: the same body against another market is another order.
            requestHash: hashRequest({ symbol, ...body }),
          }),
        );

        idempotencyOutcomes.inc({ outcome: outcome.status });

        switch (outcome.status) {
          case 'replay':
            // 200 for a replayed 201: the order was created by the first
            // request, not this one. Any other recorded status is replayed as
            // it was — a refusal is still a refusal.
            //
            // The cast is to the route's declared statuses: only this handler
            // ever records one, and it records only those.
            reply.status(
              outcome.responseStatus === 201 ? 200 : (outcome.responseStatus as 404 | 409 | 422),
            );
            return outcome.responseBody as never;

          case 'in_progress':
            reply.status(409);
            return {
              error: 'request_in_progress',
              message: 'a request with this Idempotency-Key is still being processed',
            };

          case 'mismatch':
            reply.status(422);
            return {
              error: 'idempotency_key_reused',
              message: 'this Idempotency-Key was used with a different request',
            };

          case 'claimed':
            claimedKeyId = outcome.id;
            break;
        }
      }

      const keyId = claimedKeyId;

      const acceptedPayload = (accepted: { order: BookOrder; fills: Fill[] }) => ({
        order: orderOut(participant.externalId, accepted.order),
        fills: accepted.fills.map((f) => ({
          price: formatCash(f.price),
          quantity: formatQuantity(f.quantity),
          notional: formatCash(f.notional),
        })),
      });

      /**
       * Record a definite answer against the key, then send it.
       *
       * Used for refusals, which rolled back and moved nothing — so there is no
       * window here in which money has moved and the key does not know. The
       * accepted case cannot use this; see `onAccepted` below.
       *
       * Recorded as `completed`, not `failed`: the request completed, with a
       * refusal. A retry should hear the same refusal, not match the book a
       * second time and perhaps trade.
       */
      const answer = async <T>(status: 404 | 409 | 422, payload: T): Promise<T> => {
        if (keyId !== undefined) {
          await settle(app.pool, keyId, {
            state: 'completed',
            responseStatus: status,
            responseBody: payload,
          });
        }
        reply.status(status);
        return payload;
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
            /**
             * The response is recorded **inside the matching transaction**. The
             * order, its trades, its ledger entries and the answer a retry will
             * be given commit together or not at all.
             */
            ...(keyId === undefined
              ? {}
              : {
                  onAccepted: (client, accepted) =>
                    settle(client, keyId, {
                      state: 'completed',
                      responseStatus: 201,
                      responseBody: acceptedPayload(accepted),
                    }),
                }),
          }),
        );

        count(result.status);

        switch (result.status) {
          case 'accepted':
            if (result.fills.length > 0) {
              exchangeTradesTotal.inc({ taker_side: body.side }, result.fills.length);
            }

            reply.status(201);
            return acceptedPayload(result);

          case 'unknown_market':
            return await answer(404, { error: 'unknown_market', message: `no market ${symbol}` });

          case 'unknown_participant':
            // Not an answer about the order at all; give the key back.
            if (keyId !== undefined) await release(app.pool, keyId);
            reply.status(401);
            return UNAUTHENTICATED;

          case 'invalid_quantity':
            return await answer(422, {
              error: 'invalid_quantity',
              message:
                `quantity must be a multiple of ${formatQuantity(result.lotSize)} ` +
                `and at most ${formatQuantity(result.maxQuantity)}`,
            });

          case 'invalid_price':
            return await answer(422, {
              error: 'invalid_price',
              message:
                `limit price must be a multiple of ${formatCash(result.tickSize)} between ` +
                `${formatCash(result.minPrice)} and ${formatCash(result.maxPrice)}`,
            });

          case 'insufficient_funds': {
            const cash = result.unit === 'USD';
            const format = cash ? formatCash : formatQuantity;
            return await answer(422, {
              error: 'insufficient_funds',
              message: cash
                ? 'not enough available cash; open buy orders reserve theirs'
                : `not enough available ${result.unit}; open sell orders reserve theirs`,
              unit: result.unit,
              available: format(clamp(result.available)),
              required: format(result.required),
            });
          }

          case 'too_many_open_orders':
            return await answer(422, {
              error: 'too_many_open_orders',
              message: `at most ${String(result.limit)} open orders; cancel one first`,
            });

          case 'no_liquidity':
            return await answer(422, {
              error: 'no_liquidity',
              message: 'nothing is resting on the other side of the book',
            });
        }
      } catch (err) {
        const code = sqlstateOf(err);
        request.ctx.sqlstate = code ?? null;

        // `book_orders_external_id_key` decided this, not a prior SELECT.
        if (code === UNIQUE_VIOLATION) {
          count('duplicate');
          return await answer(409, {
            error: 'duplicate_order',
            message: `order ${body.clientOrderId} already exists`,
          });
        }

        /*
         * Anything else threw rather than answered. Give the key back so a
         * retry starts clean: recording a transient failure would replay it to
         * every retry, which is the opposite of what a retry is for.
         */
        if (keyId !== undefined) await release(app.pool, keyId).catch(() => undefined);
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

  /* ------------------------------------------------------------------- cash */

  app.route({
    method: 'POST',
    url: '/v1/exchange/deposits',
    config: { rateLimit: { max: CASH_RATE_MAX, timeWindow: 60_000 } },
    schema: {
      tags: ['exchange'],
      summary: 'Deposit cash through the simulated payment provider.',
      description: [
        'There is no real provider. This endpoint plays one: it builds a',
        '`funding.succeeded` event for the session’s account, signs it with the',
        'webhook secret, and delivers it to `POST /v1/webhooks/simbank` — the',
        'real inbound handler, with its signature check, its unique index and its',
        'state machine. Nothing here credits an account directly.',
        '',
        '`deliveries` asks the provider to send the same event that many times',
        '**at once**, which is what at-least-once delivery looks like on a bad',
        'day. Exactly one is processed. The rest come back as duplicates, or as',
        '409 while the first is still in flight — and a 409 is then re-delivered,',
        'as a real provider would, until it gets a definite answer.',
        '',
        'Whether the deposit was credited is not stored on the deposit: it is',
        'read from the webhook event, which is settled in the same database',
        'transaction as the ledger entries.',
      ].join('\n'),
      body: z
        .object({
          amount: PositiveCashAmount,
          deliveries: z.number().int().min(1).max(MAX_DELIVERIES).default(1),
        })
        .strict(),
      response: {
        201: z.object({
          depositId: z.string(),
          amount: CashAmountOut,
          credited: z.boolean(),
          deliveries: z.array(
            z.object({
              delivery: z.number().int().describe('Which of the requested deliveries, from 1.'),
              retry: z.number().int().describe('0 for the first attempt.'),
              status: z.number().int(),
              outcome: z
                .string()
                .describe('`processed`, `duplicate`, `in_progress`, or a rejection code.'),
            }),
          ),
          summary: z.object({
            processed: z.number().int(),
            duplicates: z.number().int(),
            inProgress: z.number().int(),
            rejected: z.number().int(),
          }),
        }),
        401: ErrorOut,
        422: ErrorOut,
        429: ErrorOut,
      },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }

      const { amount, deliveries: requested } = request.body;

      if (amount > MAX_DEPOSIT) {
        reply.status(422);
        return {
          error: 'amount_too_large',
          message: `at most ${formatCash(MAX_DEPOSIT)} per deposit`,
        };
      }

      const { rows: recent } = await timed(request, () =>
        app.pool.query<{ recent: number }>(
          `SELECT count(*)::int AS recent FROM deposits
            WHERE participant_id = $1::bigint AND created_at > now() - interval '1 hour'`,
          [participant.id.toString()],
        ),
      );

      if (recent[0]!.recent >= MAX_DEPOSITS_PER_HOUR) {
        reply.status(429);
        return {
          error: 'deposit_limit',
          message: `at most ${String(MAX_DEPOSITS_PER_HOUR)} deposits per hour`,
        };
      }

      await timed(request, () => ensureFundingAccount(app.pool));

      const depositId = `dep_${randomUUID()}`;
      const eventId = `evt_${randomUUID()}`;

      await timed(request, () =>
        app.pool.query(
          `INSERT INTO deposits (participant_id, external_id, event_id, amount, deliveries)
           VALUES ($1::bigint, $2, $3, $4::bigint, $5::int)`,
          [participant.id.toString(), depositId, eventId, amount.toString(), requested],
        ),
      );

      /*
       * The event, serialised ONCE. Every delivery sends these same bytes, as a
       * provider re-sending a stored event does — which is also what makes the
       * handler's payload hash agree across deliveries.
       */
      const raw = Buffer.from(
        JSON.stringify({
          id: eventId,
          type: 'funding.succeeded',
          objectId: depositId,
          accountId: participant.externalId,
          amount: formatCash(amount),
        }),
        'utf8',
      );

      const deliver = async (): Promise<{ status: number; outcome: string }> => {
        // Signed per delivery, with a fresh timestamp — as Stripe documents for
        // its own retries.
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = computeSignature(env.WEBHOOK_SIGNING_SECRET, timestamp, raw);

        // In-process: no network call, and nowhere to point it but this server.
        const response = await app.inject({
          method: 'POST',
          url: '/v1/webhooks/simbank',
          headers: {
            'content-type': 'application/json',
            [SIGNATURE_HEADER]: `t=${String(timestamp)},${SIGNATURE_SCHEME}=${signature}`,
            // The matcher's locking discipline, since the two share accounts.
            // Ignored where flag headers are off, and production's default is
            // already `advisory`.
            'x-daftar-concurrency-mode': 'advisory',
          },
          payload: raw,
        });

        let parsed: { received?: boolean; state?: string; duplicate?: boolean; error?: string } =
          {};
        try {
          parsed = response.json<typeof parsed>();
        } catch {
          // A non-JSON body is a rejection like any other; the status says which.
        }

        const outcome =
          parsed.received === true
            ? parsed.duplicate === true
              ? 'duplicate'
              : (parsed.state ?? 'unknown')
            : (parsed.error ?? 'error');

        return { status: response.statusCode, outcome };
      };

      // All at once: `Promise.all` over already-created promises, so the
      // deliveries genuinely overlap in the handler.
      const first = await Promise.all(Array.from({ length: requested }, () => deliver()));

      const log = first.map((result, index) => ({ delivery: index + 1, retry: 0, ...result }));

      // A 409 (Conflict) means "still working, ask again" — so the provider does.
      for (const [index, result] of first.entries()) {
        let last = result;
        for (
          let retry = 1;
          retry <= PROVIDER_RETRIES && last.status === 409 && last.outcome === 'in_progress';
          retry += 1
        ) {
          await sleep(PROVIDER_RETRY_DELAY_MS * retry);
          last = await deliver();
          log.push({ delivery: index + 1, retry, ...last });
        }
      }

      const countOf = (outcome: string): number => log.filter((d) => d.outcome === outcome).length;
      const processed = countOf('processed');
      const duplicates = countOf('duplicate');
      const inProgress = countOf('in_progress');

      reply.status(201);
      return {
        depositId,
        amount: formatCash(amount),
        credited: processed > 0,
        deliveries: log,
        summary: {
          processed,
          duplicates,
          inProgress,
          rejected: log.length - processed - duplicates - inProgress,
        },
      };
    },
  });

  app.route({
    method: 'POST',
    url: '/v1/exchange/withdrawals',
    config: { rateLimit: { max: CASH_RATE_MAX, timeWindow: 60_000 } },
    schema: {
      tags: ['exchange'],
      summary: 'Withdraw cash from the session’s account.',
      description: [
        'One two-leg ledger transaction: the guest is debited and',
        '`external:funding` credited. It does **not** take the market lock, so it',
        'can overlap a fill against the same cash account; the ledger’s account',
        'lock and non-negative check are what keep both from spending the same',
        'money. Cash reserved by open buy orders cannot be withdrawn.',
      ].join('\n'),
      body: z.object(MovementBody).strict(),
      response: { 201: MovementOut, 401: ErrorOut, 409: ErrorOut, 422: ErrorOut },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }

      const { clientId, amount } = request.body;

      if (amount > MAX_CASH_MOVEMENT) {
        reply.status(422);
        return {
          error: 'amount_too_large',
          message: `at most ${formatCash(MAX_CASH_MOVEMENT)} per withdrawal`,
        };
      }

      try {
        const result = await timed(request, () =>
          withdraw(app.pool, {
            mover: participant,
            externalId: storedOrderId(participant.externalId, clientId),
            amount,
          }),
        );

        if (result.status === 'moved') {
          request.ctx.retryCount = result.attempts - 1;
          reply.status(201);
          return {
            status: 'completed' as const,
            amount: formatCash(amount),
            cashBalance: formatCash(result.balanceAfter),
          };
        }

        if (result.status === 'insufficient_funds') {
          reply.status(422);
          return {
            error: 'insufficient_funds',
            message: 'not enough available cash; open buy orders reserve theirs',
            unit: 'USD',
            available: formatCash(clamp(result.available)),
            required: formatCash(result.required),
          };
        }

        // `unknown_recipient` and `self_transfer` belong to transfers.
        throw new Error(`unexpected withdrawal outcome ${result.status}`);
      } catch (err) {
        const code = sqlstateOf(err);
        request.ctx.sqlstate = code ?? null;

        if (code === UNIQUE_VIOLATION) {
          reply.status(409);
          return { error: 'duplicate_movement', message: `${clientId} was already submitted` };
        }
        throw err;
      }
    },
  });

  app.route({
    method: 'POST',
    url: '/v1/exchange/transfers',
    config: { rateLimit: { max: CASH_RATE_MAX, timeWindow: 60_000 } },
    schema: {
      tags: ['exchange'],
      summary: 'Send cash to another guest, by their handle.',
      description: [
        'One two-leg ledger transaction between two guests’ cash accounts. Like',
        'a withdrawal it runs outside the market lock. Two guests paying each',
        'other at the same instant is the textbook deadlock; it cannot happen',
        'here because both transactions lock the two accounts in ascending id',
        'order.',
        '',
        'The recipient is named by `handle`, a public code from `GET',
        '/v1/exchange/me` — never by account id.',
      ].join('\n'),
      body: z
        .object({
          ...MovementBody,
          toHandle: z
            .string()
            .regex(/^[0-9a-f]{10}$/, 'must be a 10-character handle')
            .describe('The recipient’s handle.'),
        })
        .strict(),
      response: { 201: MovementOut, 401: ErrorOut, 404: ErrorOut, 409: ErrorOut, 422: ErrorOut },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }

      const { clientId, amount, toHandle } = request.body;

      if (amount > MAX_CASH_MOVEMENT) {
        reply.status(422);
        return {
          error: 'amount_too_large',
          message: `at most ${formatCash(MAX_CASH_MOVEMENT)} per transfer`,
        };
      }

      try {
        const result = await timed(request, () =>
          transfer(app.pool, {
            mover: participant,
            externalId: storedOrderId(participant.externalId, clientId),
            toHandle,
            amount,
          }),
        );

        switch (result.status) {
          case 'moved':
            request.ctx.retryCount = result.attempts - 1;
            reply.status(201);
            return {
              status: 'completed' as const,
              amount: formatCash(amount),
              cashBalance: formatCash(result.balanceAfter),
            };

          case 'unknown_recipient':
            reply.status(404);
            return { error: 'unknown_recipient', message: `no guest with handle ${toHandle}` };

          case 'self_transfer':
            reply.status(422);
            return { error: 'self_transfer', message: 'that handle is your own' };

          case 'insufficient_funds':
            reply.status(422);
            return {
              error: 'insufficient_funds',
              message: 'not enough available cash; open buy orders reserve theirs',
              unit: 'USD',
              available: formatCash(clamp(result.available)),
              required: formatCash(result.required),
            };
        }
      } catch (err) {
        const code = sqlstateOf(err);
        request.ctx.sqlstate = code ?? null;

        if (code === UNIQUE_VIOLATION) {
          reply.status(409);
          return { error: 'duplicate_movement', message: `${clientId} was already submitted` };
        }
        throw err;
      }
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/exchange/activity',
    schema: {
      tags: ['exchange'],
      summary: "The session's activity feed, as delivered by the outbox worker.",
      description: [
        'Trades, deposits, withdrawals and transfers. Nothing writes this feed',
        'directly: each event is an outbox row committed in the same database',
        'transaction as the money it describes, and published here afterwards by',
        'a worker.',
        '',
        'So the feed can be **behind** — `pending` says by how many events — but',
        'it cannot be missing one or contain one that did not happen. Delivery',
        'is at-least-once and the feed is idempotent, so a re-delivered event is',
        'still one row.',
      ].join('\n'),
      querystring: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      response: {
        200: z.object({ pending: z.number().int(), events: z.array(ActivityOut) }),
        401: ErrorOut,
      },
    },
    handler: async (request, reply) => {
      const participant = await authenticate(app.pool, request);
      if (!participant) {
        reply.status(401);
        return UNAUTHENTICATED;
      }

      const [events, pending] = await timed(request, () =>
        Promise.all([
          listActivity(app.pool, participant.id, request.query.limit),
          pendingActivity(app.pool, participant.cashAccountId),
        ]),
      );

      /*
       * Outbox payloads carry amounts as minor-unit integer strings — the
       * bigint's own digits. They are formatted here, at the boundary, like
       * every other amount; a value that is not one is shown as absent rather
       * than guessed at.
       */
      const minor = (value: unknown): bigint | null =>
        typeof value === 'string' && /^-?\d+$/.test(value) ? BigInt(value) : null;
      const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

      return {
        pending,
        events: events.map((event) => {
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          const amount = minor(payload['notional']) ?? minor(payload['amount']);
          const price = minor(payload['price']);
          const quantity = minor(payload['quantity']);
          const side: 'buy' | 'sell' | null =
            payload['side'] === 'buy' ? 'buy' : payload['side'] === 'sell' ? 'sell' : null;
          const liquidity: 'maker' | 'taker' | null =
            payload['liquidity'] === 'maker'
              ? 'maker'
              : payload['liquidity'] === 'taker'
                ? 'taker'
                : null;

          return {
            id: event.id.toString(),
            type: event.eventType,
            occurredAt: event.occurredAt,
            publishedAt: event.publishedAt,
            amount: amount === null ? null : formatCash(amount),
            symbol: text(payload['symbol']),
            side,
            liquidity,
            price: price === null ? null : formatCash(price),
            quantity: quantity === null ? null : formatQuantity(quantity),
            counterparty: text(payload['counterparty']),
          };
        }),
      };
    },
  });
};
