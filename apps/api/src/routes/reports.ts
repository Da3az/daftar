import { z } from 'zod';
import { formatCash, formatQuantity } from '@daftar/money';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { timed } from '../plugins/request-context.ts';
import { CashAmountOut, ExternalId } from '../contracts/money.ts';
import { normaliseTimestamp } from '../db/timestamps.ts';
import { statementSql } from '../reports/queries.ts';

/**
 * # Read endpoints for the UI
 *
 * Separate from the write routes because they have a different shape of risk.
 * Nothing here mutates anything; what they can all do instead is return too
 * much data or run an unindexed scan over 10M rows, so every one of them is
 * bounded and every bound is explained.
 *
 * ## Units are formatted at the boundary, by unit
 *
 * An `entries` row carries its `unit` alongside its `amount`, and the two
 * scales differ: cash is 2 decimal places, an asset quantity is 8. Formatting
 * with the wrong one is off by a factor of a million and still looks like a
 * plausible number, so `formatByUnit` dispatches on the row's own unit rather
 * than on anything the caller said.
 */

const UNIT_USD = 'USD';

/**
 * Format a minor-unit bigint using the scale its unit actually has.
 *
 * `USD` is the single cash unit (see CONVENTIONS.md — single currency, no FX).
 * Everything else is an asset quantity at 8 decimal places.
 */
function formatByUnit(amount: bigint, unit: string): string {
  return unit === UNIT_USD ? formatCash(amount) : formatQuantity(amount);
}

const Leg = z.object({
  accountExternalId: z.string(),
  accountKind: z.string(),
  direction: z.enum(['debit', 'credit']),
  unit: z.string(),
  amount: z.string().describe('Signed exact decimal string, scaled for its unit.'),
});

const TransactionOut = z.object({
  id: z.string().describe('Ledger transaction id, as a decimal string.'),
  kind: z.string(),
  createdAt: z.string(),
  /**
   * **Every** leg, not just the customer's.
   *
   * A transaction with one leg shown is not a double-entry record, it is a bank
   * statement. The Transactions page expands a row to show both sides summing
   * to zero, which is the whole claim of the system made visible.
   */
  legs: z.array(Leg),
  order: z
    .object({
      externalId: z.string(),
      symbol: z.string(),
      side: z.enum(['buy', 'sell']),
      quantity: z.string(),
      price: CashAmountOut,
      notional: CashAmountOut,
      status: z.string(),
      idempotencyKey: z.string().nullable(),
    })
    .nullable(),
  /** The inbound webhook event that settled this, if one did. */
  webhookEvent: z
    .object({
      id: z.string(),
      provider: z.string(),
      idempotencyKey: z.string(),
      eventType: z.string(),
    })
    .nullable(),
});

const StatementRow = z.object({
  entryId: z.string(),
  createdAt: z.string(),
  transactionId: z.string(),
  transactionKind: z.string(),
  direction: z.enum(['debit', 'credit']),
  unit: z.string(),
  /** Signed: negative for a debit. The T-account view splits on the sign. */
  amount: z.string(),
  /** Balance after this entry, in the account's own unit. */
  runningBalance: z.string(),
});

const WebhookEventOut = z.object({
  id: z.string(),
  provider: z.string(),
  eventId: z.string().describe("The provider's event id — the idempotency key."),
  objectId: z.string(),
  eventType: z.string(),
  signatureValid: z.boolean(),
  withinWindow: z.boolean(),
  /** Truncated to 16 hex characters: enough to compare, not a full digest. */
  payloadHash: z.string(),
  state: z.string(),
  deliveryCount: z.number().int(),
  /** `deliveryCount > 1` — the provider sent this event more than once. */
  duplicate: z.boolean(),
  payloadConflictCount: z.number().int(),
  transactionId: z.string().nullable(),
  errorDetail: z.string().nullable(),
  receivedAt: z.string(),
  processedAt: z.string().nullable(),
});

const ErrorOut = z.object({ error: z.string(), message: z.string() });

/**
 * One page is 50 rows and the ceiling is 200.
 *
 * Not arbitrary: the busiest seeded account has ~17k entries and the house
 * shards have ~2.5M each (Phase 3). An unbounded list endpoint over that is a
 * way to turn one HTTP request into a multi-second scan and a response large
 * enough to matter, and `LIMIT` is the only thing standing between the two.
 */
const PageLimit = z.coerce.number().int().min(1).max(200).default(50);

export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Resolve an external id to the internal bigint, once per request.
   *
   * The internal id never leaves the server — see `ExternalId` in
   * contracts/money.ts — so every read here starts with this lookup. It is one
   * indexed point read against a unique index.
   */
  const resolveAccount = async (
    externalId: string,
  ): Promise<{ id: bigint; unit: string; kind: string; balance: bigint } | null> => {
    const { rows } = await app.pool.query<{
      id: bigint;
      unit: string;
      kind: string;
      balance: bigint;
    }>('SELECT id, unit, kind, balance FROM accounts WHERE external_id = $1', [externalId]);
    return rows[0] ?? null;
  };

  app.route({
    method: 'GET',
    url: '/v1/accounts/:externalId/statement',
    schema: {
      tags: ['reports'],
      summary: 'Account statement with a running balance. The T-account view.',
      description: [
        'Entries for one account in `(created_at, id)` order, each with the',
        'balance after it.',
        '',
        '**The ordering is load-bearing.** A running balance is a window',
        'function, and a window function’s frame is defined by its `ORDER BY`.',
        'Ordering by `created_at` alone leaves ties unspecified — and ties are',
        'guaranteed, because a four-leg order writes all four entries in one',
        'statement with one `now()`. Two readers would then disagree about what',
        'the balance was at a given row. `id` makes the order total.',
        '',
        'This is the query Phase 6 indexed; see',
        'docs/evidence/06-query-performance.md for the before/after plans.',
      ].join('\n'),
      params: z.object({ externalId: ExternalId }),
      querystring: z.object({ limit: PageLimit }),
      response: {
        200: z.object({
          account: z.object({ externalId: z.string(), kind: z.string(), unit: z.string() }),
          rows: z.array(StatementRow),
        }),
        404: ErrorOut,
      },
    },
    handler: async (request, reply) => {
      const account = await timed(request, () => resolveAccount(request.params.externalId));
      if (!account) {
        reply.status(404);
        return { error: 'unknown_account', message: `no account ${request.params.externalId}` };
      }

      request.ctx.accountId = account.id;

      const sql = await statementSql();
      const { rows } = await timed(request, () =>
        app.pool.query<{
          id: bigint;
          created_at: string;
          transaction_id: bigint;
          transaction_kind: string;
          direction: 'debit' | 'credit';
          unit: string;
          amount: bigint;
          running_balance: bigint;
        }>(sql, [account.id, request.query.limit]),
      );

      return {
        account: { externalId: request.params.externalId, kind: account.kind, unit: account.unit },
        rows: rows.map((r) => ({
          entryId: r.id.toString(),
          createdAt: normaliseTimestamp(r.created_at),
          transactionId: r.transaction_id.toString(),
          transactionKind: r.transaction_kind,
          direction: r.direction,
          unit: r.unit,
          amount: formatByUnit(r.amount, r.unit),
          runningBalance: formatByUnit(r.running_balance, r.unit),
        })),
      };
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/accounts/:externalId/positions',
    schema: {
      tags: ['reports'],
      summary: 'Cash and asset positions for one customer. The dashboard query.',
      description: [
        'Cash balance plus every asset position, with cost basis.',
        '',
        '**Cost basis comes from the orders table, not from the ledger.** The',
        'ledger records what moved; it does not record what you paid on average,',
        'because that is a derived figure and deriving it needs the per-order',
        'prices. Sum of notional over sum of quantity, both as integers.',
        '',
        'Position accounts are discovered by `unit`, so an asset the customer',
        'has never traded simply does not appear rather than appearing as zero.',
      ].join('\n'),
      params: z.object({ externalId: ExternalId }),
      response: {
        200: z.object({
          externalId: z.string(),
          cash: CashAmountOut,
          positions: z.array(
            z.object({
              symbol: z.string(),
              quantity: z.string(),
              /** `null` when the position exists but no order explains it. */
              costBasis: CashAmountOut.nullable(),
              referencePrice: CashAmountOut,
              marketValue: CashAmountOut,
            }),
          ),
        }),
        404: ErrorOut,
      },
    },
    handler: async (request, reply) => {
      const account = await timed(request, () => resolveAccount(request.params.externalId));
      if (!account || account.kind !== 'customer_cash') {
        reply.status(404);
        return {
          error: 'unknown_account',
          message: `no cash account ${request.params.externalId}`,
        };
      }

      request.ctx.accountId = account.id;

      /**
       * One round trip for the whole page.
       *
       * The cost-basis aggregate is scoped to `cash_account_id`, which has an
       * index — `orders_cash_account_idx`. Doing this as one query per position
       * would be an N+1 on a page that renders on every dashboard load.
       */
      const { rows } = await timed(request, () =>
        app.pool.query<{
          symbol: string;
          quantity: bigint;
          total_notional: bigint | null;
          total_quantity: bigint | null;
          reference_price: bigint;
        }>(
          /*
           * `starts_with`, not `LIKE $2 || ':%'`.
           *
           * `ExternalId` permits `_`, which is a LIKE single-character
           * wildcard — so `seed_000001` would have matched `seed-000001:BTC`
           * and reported another customer's position as this one's.
           * `starts_with` has no pattern language, so there is nothing to
           * escape and nothing to get wrong.
           */
          `WITH position_accounts AS (
             SELECT a.unit AS symbol, a.balance AS quantity
               FROM accounts a
              WHERE starts_with(a.external_id, $2::text || ':')
                AND a.kind = 'customer_asset'
                AND a.balance <> 0
           ),
           basis AS (
             SELECT o.symbol,
                    sum(o.notional) FILTER (WHERE o.side = 'buy')::bigint AS total_notional,
                    sum(o.quantity) FILTER (WHERE o.side = 'buy')::bigint AS total_quantity
               FROM orders o
              WHERE o.cash_account_id = $1::bigint
              GROUP BY o.symbol
           )
           SELECT p.symbol,
                  p.quantity,
                  b.total_notional,
                  b.total_quantity,
                  i.reference_price
             FROM position_accounts p
             JOIN instruments i ON i.symbol = p.symbol
             LEFT JOIN basis b ON b.symbol = p.symbol
            ORDER BY p.symbol`,
          [account.id, request.params.externalId],
        ),
      );

      return {
        externalId: request.params.externalId,
        // From the account row already fetched. A cash account's `unit` is
        // always USD — the kind check above guarantees it.
        cash: formatCash(account.balance),
        positions: rows.map((r) => ({
          symbol: r.symbol,
          quantity: formatQuantity(r.quantity),
          costBasis: averageCost(r.total_notional, r.total_quantity),
          referencePrice: formatCash(r.reference_price),
          marketValue: formatCash(marketValue(r.quantity, r.reference_price)),
        })),
      };
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/accounts/:externalId/transactions',
    schema: {
      tags: ['reports'],
      summary: 'Ledger transactions touching this account, with every leg.',
      description: [
        'Keyset pagination on `before`, not `OFFSET`.',
        '',
        '`OFFSET n` makes the database walk and discard n rows, so page 100 of a',
        'list costs a hundred times page 1 — and a row inserted while the user',
        'is paging shifts every subsequent page by one, which silently skips a',
        'record. A cursor on the transaction id has neither problem.',
      ].join('\n'),
      params: z.object({ externalId: ExternalId }),
      querystring: z.object({
        limit: PageLimit,
        before: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe('Return transactions with an id strictly below this. The cursor.'),
      }),
      response: {
        200: z.object({
          transactions: z.array(TransactionOut),
          /** `null` when there is no further page. */
          nextCursor: z.string().nullable(),
        }),
        404: ErrorOut,
      },
    },
    handler: async (request, reply) => {
      const account = await timed(request, () => resolveAccount(request.params.externalId));
      if (!account) {
        reply.status(404);
        return { error: 'unknown_account', message: `no account ${request.params.externalId}` };
      }

      request.ctx.accountId = account.id;
      const before = request.query.before === undefined ? null : BigInt(request.query.before);

      /**
       * Two queries, deliberately — not one join.
       *
       * Joining legs onto the page of transactions in a single statement means
       * the `LIMIT` applies to leg rows rather than transactions, so a page
       * would contain a partial transaction. Selecting the page of ids first and
       * then every leg for exactly those ids keeps the limit on the unit the
       * caller asked for, and the second query is an indexed lookup on
       * `entries_transaction_id_idx`.
       */
      const { rows: page } = await timed(request, () =>
        app.pool.query<{
          id: bigint;
          kind: string;
          created_at: string;
        }>(
          `SELECT DISTINCT t.id, t.kind, t.created_at
             FROM entries e
             JOIN ledger_transactions t ON t.id = e.transaction_id
            WHERE e.account_id = $1::bigint
              AND ($2::bigint IS NULL OR t.id < $2::bigint)
            ORDER BY t.id DESC
            LIMIT $3::int`,
          [account.id, before, request.query.limit],
        ),
      );

      if (page.length === 0) return { transactions: [], nextCursor: null };

      const ids = page.map((r) => r.id);

      const { rows: legs } = await timed(request, () =>
        app.pool.query<{
          transaction_id: bigint;
          account_external_id: string;
          account_kind: string;
          direction: 'debit' | 'credit';
          unit: string;
          amount: bigint;
        }>(
          `SELECT e.transaction_id,
                  a.external_id AS account_external_id,
                  a.kind        AS account_kind,
                  e.direction,
                  e.unit,
                  e.amount
             FROM entries e
             JOIN accounts a ON a.id = e.account_id
            WHERE e.transaction_id = ANY($1::bigint[])
            ORDER BY e.transaction_id DESC, e.id`,
          [ids],
        ),
      );

      const { rows: orders } = await timed(request, () =>
        app.pool.query<{
          transaction_id: bigint;
          external_id: string;
          symbol: string;
          side: 'buy' | 'sell';
          quantity: bigint;
          price: bigint;
          notional: bigint;
          status: string;
          idempotency_key: string | null;
        }>(
          `SELECT transaction_id, external_id, symbol, side, quantity, price,
                  notional, status, idempotency_key
             FROM orders
            WHERE transaction_id = ANY($1::bigint[])`,
          [ids],
        ),
      );

      const { rows: events } = await timed(request, () =>
        app.pool.query<{
          transaction_id: bigint;
          id: bigint;
          provider: string;
          idempotency_key: string;
          event_type: string;
        }>(
          `SELECT transaction_id, id, provider, idempotency_key, event_type
             FROM webhook_events
            WHERE transaction_id = ANY($1::bigint[])`,
          [ids],
        ),
      );

      const legsByTransaction = new Map<string, typeof legs>();
      for (const leg of legs) {
        const key = leg.transaction_id.toString();
        const list = legsByTransaction.get(key);
        if (list) list.push(leg);
        else legsByTransaction.set(key, [leg]);
      }

      const orderByTransaction = new Map(orders.map((o) => [o.transaction_id.toString(), o]));
      const eventByTransaction = new Map(events.map((e) => [e.transaction_id.toString(), e]));

      const transactions = page.map((t) => {
        const key = t.id.toString();
        const order = orderByTransaction.get(key);
        const event = eventByTransaction.get(key);

        return {
          id: key,
          kind: t.kind,
          createdAt: normaliseTimestamp(t.created_at),
          legs: (legsByTransaction.get(key) ?? []).map((leg) => ({
            accountExternalId: leg.account_external_id,
            accountKind: leg.account_kind,
            direction: leg.direction,
            unit: leg.unit,
            amount: formatByUnit(leg.amount, leg.unit),
          })),
          order:
            order === undefined
              ? null
              : {
                  externalId: order.external_id,
                  symbol: order.symbol,
                  side: order.side,
                  quantity: formatQuantity(order.quantity),
                  price: formatCash(order.price),
                  notional: formatCash(order.notional),
                  status: order.status,
                  idempotencyKey: order.idempotency_key,
                },
          webhookEvent:
            event === undefined
              ? null
              : {
                  id: event.id.toString(),
                  provider: event.provider,
                  idempotencyKey: event.idempotency_key,
                  eventType: event.event_type,
                },
        };
      });

      /**
       * The cursor is the last id on this page, and it is `null` only when the
       * page came back short. Returning the last id on a full-looking page the
       * caller cannot advance past would make the UI loop forever.
       */
      const last = page[page.length - 1];
      return {
        transactions,
        nextCursor:
          page.length < request.query.limit || last === undefined ? null : last.id.toString(),
      };
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/webhooks/events',
    schema: {
      tags: ['reports'],
      summary: 'Inbound webhook events. The settlements view.',
      description: [
        'Every delivery the system has seen, including the ones it rejected.',
        '',
        'Rejected deliveries are **stored**, not dropped: a stale replay and a',
        'forged signature are different events and both are worth seeing. The',
        'payload hash is what makes a same-key-different-body conflict',
        'detectable at all, and `payloadConflictCount` records how many times it',
        'has happened.',
        '',
        'The hash is truncated to 16 hex characters in the response — enough to',
        'compare two deliveries by eye, not enough to be mistaken for the digest',
        'the signature is computed over.',
      ].join('\n'),
      querystring: z.object({
        limit: PageLimit,
        before: z.string().regex(/^\d+$/).optional(),
        provider: z.string().min(1).max(32).optional(),
      }),
      response: {
        200: z.object({
          events: z.array(WebhookEventOut),
          nextCursor: z.string().nullable(),
        }),
      },
    },
    handler: async (request) => {
      const before = request.query.before === undefined ? null : BigInt(request.query.before);

      const { rows } = await timed(request, () =>
        app.pool.query<{
          id: bigint;
          provider: string;
          idempotency_key: string;
          object_id: string;
          event_type: string;
          signature_valid: boolean;
          within_window: boolean;
          payload_hash: string;
          state: string;
          delivery_count: number;
          payload_conflict_count: number;
          transaction_id: bigint | null;
          error_detail: string | null;
          received_at: string;
          processed_at: string | null;
        }>(
          `SELECT id, provider, idempotency_key, object_id, event_type,
                  signature_valid, within_window, payload_hash, state,
                  delivery_count, payload_conflict_count, transaction_id,
                  error_detail, received_at, processed_at
             FROM webhook_events
            WHERE ($1::bigint IS NULL OR id < $1::bigint)
              AND ($2::text IS NULL OR provider = $2::text)
            ORDER BY id DESC
            LIMIT $3::int`,
          [before, request.query.provider ?? null, request.query.limit],
        ),
      );

      const last = rows[rows.length - 1];

      return {
        events: rows.map((r) => ({
          id: r.id.toString(),
          provider: r.provider,
          eventId: r.idempotency_key,
          objectId: r.object_id,
          eventType: r.event_type,
          signatureValid: r.signature_valid,
          withinWindow: r.within_window,
          payloadHash: r.payload_hash.slice(0, 16),
          state: r.state,
          deliveryCount: r.delivery_count,
          duplicate: r.delivery_count > 1,
          payloadConflictCount: r.payload_conflict_count,
          transactionId: r.transaction_id === null ? null : r.transaction_id.toString(),
          errorDetail: r.error_detail,
          receivedAt: normaliseTimestamp(r.received_at),
          processedAt: r.processed_at === null ? null : normaliseTimestamp(r.processed_at),
        })),
        nextCursor:
          rows.length < request.query.limit || last === undefined ? null : last.id.toString(),
      };
    },
  });
};

/**
 * Average cost per unit, in cash minor units.
 *
 * Integer division, truncating — and that is the correct choice here rather
 * than a rounded one. A cost basis is a *display* figure derived from two sums
 * that are themselves exact; rounding it would imply a precision the derivation
 * does not have, and no ledger entry is ever computed from it.
 *
 * `null` rather than zero when there are no buys. Zero cost basis and unknown
 * cost basis are different facts, and showing "$0.00" for a position that
 * arrived by funding rather than by purchase is simply wrong.
 */
function averageCost(totalNotional: bigint | null, totalQuantity: bigint | null): string | null {
  if (totalNotional === null || totalQuantity === null || totalQuantity === 0n) return null;
  // Quantity is scaled by 1e8; notional by 1e2. Cost per whole unit is
  // notional / (quantity / 1e8) = notional * 1e8 / quantity.
  return formatCash((totalNotional * 100_000_000n) / totalQuantity);
}

/**
 * Market value of a position at the reference price.
 *
 * `quantity` is scaled by 1e8 and `price` by 1e2, so the product is scaled by
 * 1e10 and has to come back down by 1e8 to be cash minor units. Done as one
 * integer expression rather than two steps, so no intermediate is truncated
 * before the division that needs its digits.
 */
function marketValue(quantity: bigint, price: bigint): bigint {
  return (quantity * price) / 100_000_000n;
}
