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
  findMovement,
  findRecipient,
  ledgerLinesFor,
  listActivity,
  ownReferencesFor,
  contributionsOf,
  pendingActivity,
  transfer,
} from '../exchange/cash.ts';
import { GUEST_STARTING_CASH, createGuest, findParticipant } from '../exchange/participants.ts';
import { buildMarketSnapshot } from '../exchange/snapshot.ts';
import {
  findWithdrawalByExternalId,
  holdSplit,
  requestWithdrawal,
} from '../exchange/withdrawals.ts';
import {
  CANDLE_INTERVALS,
  getBalances,
  getCandles,
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

/**
 * Orders one IP may place per minute, and — separately — cancels. Each route
 * has its own counter: `@fastify/rate-limit` gives every route a store of its
 * own, so the two do not share a budget. Generous for a person.
 */
const ORDER_RATE_MAX = 120;

/**
 * Deposits, withdrawals and transfers one IP may make per minute — each, not
 * together, for the same reason.
 */
const CASH_RATE_MAX = 30;

/** Recipient lookups one IP may make per minute. Its own budget, so typing a
 * handle wrong does not use up the sends. */
const LOOKUP_RATE_MAX = 30;

/**
 * Public market data, per IP per minute, per route.
 *
 * Its own limit rather than the global one: the screen polls the market and the
 * candles once a second each, so a few tabs behind one address — or everyone
 * behind one proxy — would otherwise spend the global budget the session routes
 * need. 600 is ten tabs.
 */
const MARKET_RATE_MAX = 600;

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

export const QuantityOut = z
  .string()
  .regex(/^\d+\.\d{8}$/)
  .describe('Asset quantity as an exact decimal string, 8 fractional digits.');

export const SymbolQuery = z.object({
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

/**
 * The strict form, for anything not already filtered to the viewer's own rows:
 * `null` unless the stored id carries the viewer's own prefix. The lenient one
 * above returns a foreign id unchanged — which, for another guest's row, would
 * hand out that guest's session subject.
 */
const ownClientIdOf = (participantExternalId: string, stored: string): string | null =>
  stored.startsWith(`${participantExternalId}:`)
    ? stored.slice(participantExternalId.length + 1)
    : null;

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
  cashOnHold: CashAmountOut.optional().describe(
    'Withdrawals not yet sent to the payout rail (held, in review, or failed and being ' +
      'released). Still yours, not spendable. Not included in `cash`.',
  ),
  cashPending: CashAmountOut.optional().describe(
    'Withdrawals sent to the rail and awaiting its confirmation. Not included in `cash`.',
  ),
  asset: QuantityOut,
  assetAvailable: QuantityOut,
});

/** Client-chosen id for a withdrawal or transfer; same shape as an order's. */
const MovementBody = {
  clientId: ClientOrderId.describe('Client-chosen id for this movement, unique per participant.'),
  amount: PositiveCashAmount,
};

const MovementOut = z.object({
  status: z
    .enum(['completed', 'held', 'review', 'submitted', 'confirmed', 'failed', 'released'])
    .describe(
      '`completed` for a transfer. For a withdrawal, the state it is in: it is a saga now — ' +
        'see GET /v1/exchange/withdrawals for its progress.',
    ),
  withdrawalId: z.string().optional().describe('For a withdrawal: the id its tracker is keyed by.'),
  amount: CashAmountOut,
  cashBalance: CashAmountOut.describe(
    'The cash the movement left. On a replay, the figure the original request got.',
  ),
  clientId: z.string().describe('Echo of the client id, which keys the receipt.'),
  occurredAt: z
    .string()
    .describe('When the money moved: the database clock at the start of its transaction.'),
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
  counterparty: z
    .string()
    .nullable()
    .describe('The other side’s display name, for trades and transfers.'),
  reference: z
    .string()
    .nullable()
    .describe(
      'The id a receipt is found by: the order’s `clientOrderId` for a trade, the ' +
        '`clientId` for a withdrawal or a transfer sent, the `depositId` for a deposit. ' +
        'NULL for a transfer received — the sender’s id is not the recipient’s to see.',
    ),
  entries: z
    .array(
      z.object({
        account: z.string().describe('A display label, never an account id.'),
        direction: z
          .enum(['debit', 'credit'])
          .describe('A debit takes value out of the account; a credit puts it in.'),
        amount: z.string().describe('Exact decimal string in `unit`.'),
        unit: z.string().describe('`USD`, or the market symbol.'),
      }),
    )
    .describe(
      'The balanced ledger transaction behind the event: per unit, debits equal credits. ' +
        'Empty for an event older than the link from feed to ledger.',
    ),
});

export const ErrorOut = z.object({
  error: z.string(),
  message: z.string(),
  unit: z.string().optional(),
  available: z.string().optional(),
  required: z.string().optional(),
  retryAfterSeconds: z
    .number()
    .int()
    .optional()
    .describe('On 429: seconds until the limit frees a slot. Mirrors `Retry-After`.'),
});

export const UNAUTHENTICATED = {
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
export async function authenticate(pool: pg.Pool, request: FastifyRequest) {
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

  /**
   * The answer to a withdrawal or transfer whose client id was already used.
   *
   * Same movement → the original result, with a 200 rather than a 201, so the
   * client can tell a replay from a new movement as it does for orders. A
   * different movement under the same id → 409. `null` when the id is unused.
   */
  const replayMovement = async (
    request: FastifyRequest,
    participant: { id: bigint; externalId: string; cashAccountId: bigint },
    clientId: string,
    expected: { kind: 'withdrawal' | 'transfer'; amount: bigint; toHandle: string | null },
  ) => {
    const stored = await timed(request, () =>
      findMovement(app.pool, participant.id, storedOrderId(participant.externalId, clientId)),
    );
    if (!stored) return null;

    const same =
      stored.kind === expected.kind &&
      stored.amount === expected.amount &&
      stored.counterpartyHandle === expected.toHandle;
    if (!same) {
      return {
        status: 409 as const,
        body: {
          error: 'duplicate_movement',
          message: `${clientId} was already used for a different movement`,
        },
      };
    }

    // Movements made before `balance_after` existed fall back to today's cash.
    let balance = stored.balanceAfter;
    if (balance === null) {
      const { rows } = await app.pool.query<{ balance: bigint }>(
        'SELECT balance FROM accounts WHERE id = $1::bigint',
        [participant.cashAccountId.toString()],
      );
      balance = rows[0]?.balance ?? 0n;
    }

    const saga =
      stored.kind === 'withdrawal'
        ? await findWithdrawalByExternalId(
            app.pool,
            participant.id,
            storedOrderId(participant.externalId, clientId),
          )
        : null;

    return {
      status: 200 as const,
      body: {
        status: saga
          ? saga.state === 'requested'
            ? ('held' as const)
            : saga.state
          : ('completed' as const),
        ...(saga ? { withdrawalId: saga.id.toString() } : {}),
        amount: formatCash(stored.amount),
        cashBalance: formatCash(balance),
        clientId,
        occurredAt: stored.createdAt,
      },
    };
  };

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
          contributions: z
            .object({
              openingCredit: CashAmountOut,
              deposits: CashAmountOut,
              transfersIn: CashAmountOut,
              withdrawals: CashAmountOut,
              transfersOut: CashAmountOut,
            })
            .describe(
              'The parts of `netContributed`, read in the same statement, so ' +
                'openingCredit + deposits + transfersIn − withdrawals − transfersOut = netContributed.',
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

      const [balances, openOrders, contributed, pendingEvents, holds] = await timed(request, () =>
        Promise.all([
          getBalances(app.pool, participant, symbol),
          listOrders(app.pool, participant.id, { openOnly: true, limit: 100 }),
          contributionsOf(app.pool, participant.cashAccountId),
          pendingActivity(app.pool, participant.cashAccountId),
          holdSplit(app.pool, participant.id),
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
        netContributed: formatCash(contributed.net),
        contributions: {
          openingCredit: formatCash(contributed.openingCredit),
          deposits: formatCash(contributed.deposits),
          transfersIn: formatCash(contributed.transfersIn),
          withdrawals: formatCash(contributed.withdrawals),
          transfersOut: formatCash(contributed.transfersOut),
        },
        pendingEvents,
        balances: {
          cash: formatCash(balances.cash),
          cashAvailable: formatCash(clamp(balances.cashAvailable)),
          cashOnHold: formatCash(holds.onHold),
          cashPending: formatCash(holds.pending),
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
    config: { rateLimit: { max: MARKET_RATE_MAX, timeWindow: 60_000 } },
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
      const snapshot = await timed(request, () =>
        buildMarketSnapshot(app.pool, symbol, depth, tapeLimit),
      );
      if (!snapshot) {
        reply.status(404);
        return { error: 'unknown_market', message: `no market ${symbol}` };
      }
      return snapshot;
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/exchange/candles',
    config: { rateLimit: { max: MARKET_RATE_MAX, timeWindow: 60_000 } },
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
              counterparty: z
                .string()
                .nullable()
                .describe('The other side’s display name, e.g. a bot’s "Kestrel".'),
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
          counterparty: f.counterparty,
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
              latencyMs: z
                .number()
                .int()
                .nonnegative()
                .describe(
                  'Milliseconds from dispatch to the webhook’s answer, for this attempt alone ' +
                    '(a retry’s back-off is not included). The first wave is sent at once, so ' +
                    'its times include waiting on each other.',
                ),
            }),
          ),
          summary: z.object({
            processed: z.number().int(),
            duplicates: z.number().int(),
            inProgress: z.number().int(),
            rejected: z.number().int(),
          }),
          cashBalance: CashAmountOut.describe(
            'The account’s cash, read after every delivery settled. It can include another ' +
              'movement that landed at the same moment, so it is not always the old ' +
              'balance plus this deposit.',
          ),
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
        /*
         * When a slot frees: the hour after the deposit that would have to age
         * out. That is the MAX-th newest, not the oldest — the count-then-insert
         * above can race and leave more than MAX rows in the window.
         */
        const { rows: frees } = await app.pool.query<{ seconds: number | null }>(
          `SELECT ceil(extract(epoch FROM created_at + interval '1 hour' - now()))::int AS seconds
             FROM deposits
            WHERE participant_id = $1::bigint
            ORDER BY created_at DESC
            OFFSET $2::int LIMIT 1`,
          [participant.id.toString(), MAX_DEPOSITS_PER_HOUR - 1],
        );
        const retryAfterSeconds = Math.max(1, frees[0]?.seconds ?? 1);

        reply.status(429);
        reply.header('retry-after', String(retryAfterSeconds));
        return {
          error: 'deposit_limit',
          message: `at most ${String(MAX_DEPOSITS_PER_HOUR)} deposits per hour`,
          retryAfterSeconds,
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

      const deliver = async (): Promise<{ status: number; outcome: string; latencyMs: number }> => {
        // Signed per delivery, with a fresh timestamp — as Stripe documents for
        // its own retries.
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = computeSignature(env.WEBHOOK_SIGNING_SECRET, timestamp, raw);

        // In-process: no network call, and nowhere to point it but this server.
        const started = performance.now();
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
        const latencyMs = Math.max(0, Math.round(performance.now() - started));

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

        return { status: response.statusCode, outcome, latencyMs };
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

      // After every delivery has answered, so a credit that happened is in it.
      const { rows: cash } = await timed(request, () =>
        app.pool.query<{ balance: bigint }>('SELECT balance FROM accounts WHERE id = $1::bigint', [
          participant.cashAccountId.toString(),
        ]),
      );

      reply.status(201);
      return {
        depositId,
        amount: formatCash(amount),
        cashBalance: formatCash(cash[0]?.balance ?? 0n),
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
        'Starts a withdrawal. The cash moves into the guest’s **hold account** in',
        'this request — one ledger transaction, under the account lock and the',
        'non-negative check, so it can no longer be spent — and the payout happens',
        'asynchronously: submitted to the payout rail, then confirmed (hold → outside',
        'world) or failed and released (hold → back to cash). Amounts at or above the',
        'review threshold wait for an operator first. Cash reserved by open buy',
        'orders cannot be withdrawn. Track it with GET /v1/exchange/withdrawals.',
      ].join('\n'),
      body: z.object(MovementBody).strict(),
      response: {
        201: MovementOut,
        200: MovementOut.describe('A replay: this client id was already this withdrawal.'),
        401: ErrorOut,
        409: ErrorOut,
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

      const { clientId, amount } = request.body;
      const expected = { kind: 'withdrawal' as const, amount, toHandle: null };

      // Before any check: a retry of a withdrawal that happened is answered
      // with what happened, not re-judged against the balance it left.
      const replay = await replayMovement(request, participant, clientId, expected);
      if (replay) {
        reply.status(replay.status);
        return replay.body;
      }

      if (amount > MAX_CASH_MOVEMENT) {
        reply.status(422);
        return {
          error: 'amount_too_large',
          message: `at most ${formatCash(MAX_CASH_MOVEMENT)} per withdrawal`,
        };
      }

      try {
        const result = await timed(request, () =>
          requestWithdrawal(app.pool, {
            mover: participant,
            externalId: storedOrderId(participant.externalId, clientId),
            amount,
            reviewThreshold: env.WITHDRAWAL_REVIEW_THRESHOLD,
          }),
        );

        if (result.status === 'requested') {
          request.ctx.retryCount = result.attempts - 1;
          reply.status(201);
          return {
            status: result.withdrawal.state === 'review' ? ('review' as const) : ('held' as const),
            withdrawalId: result.withdrawal.id.toString(),
            amount: formatCash(amount),
            cashBalance: formatCash(result.balanceAfter),
            clientId,
            occurredAt: result.occurredAt,
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

        throw new Error('unexpected withdrawal outcome');
      } catch (err) {
        const code = sqlstateOf(err);
        request.ctx.sqlstate = code ?? null;

        if (code === UNIQUE_VIOLATION) {
          // Two identical requests raced and the other committed first.
          const raced = await replayMovement(request, participant, clientId, expected);
          if (raced) {
            reply.status(raced.status);
            return raced.body;
          }
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
      response: {
        201: MovementOut,
        200: MovementOut.describe('A replay: this client id was already this transfer.'),
        401: ErrorOut,
        404: ErrorOut,
        409: ErrorOut,
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

      const { clientId, amount, toHandle } = request.body;
      const expected = { kind: 'transfer' as const, amount, toHandle };

      const replay = await replayMovement(request, participant, clientId, expected);
      if (replay) {
        reply.status(replay.status);
        return replay.body;
      }

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
              clientId,
              occurredAt: result.occurredAt,
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
          // Two identical requests raced and the other committed first.
          const raced = await replayMovement(request, participant, clientId, expected);
          if (raced) {
            reply.status(raced.status);
            return raced.body;
          }
          reply.status(409);
          return { error: 'duplicate_movement', message: `${clientId} was already submitted` };
        }
        throw err;
      }
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/exchange/recipients/:handle',
    config: { rateLimit: { max: LOOKUP_RATE_MAX, timeWindow: 60_000 } },
    schema: {
      tags: ['exchange'],
      summary: 'Who a handle belongs to, before sending them cash.',
      description: [
        'Answers with the display name a transfer would show anyway, and nothing',
        'more. Guests only: a bot cannot be paid, so it cannot be found either.',
        '',
        'Rate-limited on its own budget, separate from the transfers, so a',
        'mistyped handle does not use up the sends.',
      ].join('\n'),
      params: z.object({
        handle: z
          .string()
          .regex(/^[0-9a-f]{10}$/, 'must be a 10-character handle')
          .describe('The recipient’s handle.'),
      }),
      response: {
        200: z.object({ handle: z.string(), displayName: z.string() }),
        401: ErrorOut,
        404: ErrorOut,
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

      const { handle } = request.params;

      if (handle === participant.handle) {
        reply.status(422);
        return { error: 'self_transfer', message: 'that handle is your own' };
      }

      const recipient = await timed(request, () => findRecipient(app.pool, handle));
      if (!recipient) {
        reply.status(404);
        return { error: 'unknown_recipient', message: `no guest with handle ${handle}` };
      }

      return { handle: recipient.handle, displayName: recipient.displayName };
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

      // Two batched reads for the whole page, never one per row.
      const linked = events.flatMap((e) => (e.transactionId === null ? [] : [e.transactionId]));
      const [lines, refs] = await timed(request, () =>
        Promise.all([
          ledgerLinesFor(app.pool, participant, events),
          ownReferencesFor(app.pool, participant, linked),
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

      const referenceOf = (event: (typeof events)[number]): string | null => {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (event.eventType === 'transfer.received') return null;
        if (event.eventType.startsWith('deposit.')) return text(payload['depositId']);
        if (event.transactionId === null) return null;
        const stored = refs.get(event.transactionId);
        return stored === undefined ? null : ownClientIdOf(participant.externalId, stored);
      };

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
            reference: referenceOf(event),
            entries: (event.transactionId === null
              ? []
              : (lines.get(event.transactionId) ?? [])
            ).map((line) => ({
              account: line.account,
              direction: line.direction,
              amount: line.unit === 'USD' ? formatCash(line.amount) : formatQuantity(line.amount),
              unit: line.unit,
            })),
          };
        }),
      };
    },
  });
};
