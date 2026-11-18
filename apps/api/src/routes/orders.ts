import { z } from 'zod';
import { formatCash, formatQuantity } from '@daftar/money';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { timed } from '../plugins/request-context.ts';
import { CashAmountOut, ExternalId, PositiveQuantity } from '../contracts/money.ts';
import { placeOrder } from '../orders/place.ts';
import { UNIQUE_VIOLATION, sqlstateOf } from '../ledger/sqlstate.ts';
import { claim, hashRequest, settle } from '../idempotency/keys.ts';

const PlaceOrderBody = z.object({
  externalId: ExternalId.describe('Caller-supplied unique id for this order.'),
  accountId: ExternalId.describe("The customer's cash account external id."),
  symbol: z.string().min(1).max(16).describe('Instrument symbol, e.g. BTC.'),
  side: z.enum(['buy', 'sell']),
  quantity: PositiveQuantity,
});

const OrderOut = z.object({
  externalId: z.string(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  quantity: z.string().describe('Exact decimal string, 8 fractional digits.'),
  price: CashAmountOut.describe('The price frozen into this order. Never re-read.'),
  notional: CashAmountOut,
  status: z.enum(['pending', 'settled', 'rejected']),
  transactionId: z.string().describe('Ledger transaction id, as a decimal string.'),
  cashBalanceAfter: CashAmountOut,
  assetBalanceAfter: z.string(),
  /** Visible per request so the cost of a concurrency strategy is not hidden. */
  attempts: z.number().int(),
});

const ErrorOut = z.object({
  error: z.string(),
  message: z.string(),
  available: CashAmountOut.optional(),
  required: CashAmountOut.optional(),
});

export const orderRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: 'POST',
    url: '/v1/orders',
    schema: {
      tags: ['orders'],
      summary: 'Place an order. The measured write path.',
      description: [
        'Writes four ledger entries in one transaction — two in USD, two in the',
        'asset — plus the order row, atomically.',
        '',
        '**The price is frozen at order time** from the `instruments` table and',
        'never re-read. This endpoint makes no network call of any kind: no',
        'price feed, no third-party API, no DNS. That is what makes the',
        'benchmark numbers in docs/evidence/ reproducible, and what makes the',
        'amount quoted the amount charged.',
        '',
        'The concurrency strategy is chosen per request via',
        '`x-daftar-concurrency-mode`: `pessimistic`, `serializable` or',
        '`advisory`. All three are correct; see the trade-off table in the',
        'README. `attempts` in the response reports how many tries the write',
        'took, which is non-trivial only under `serializable`.',
      ].join('\n'),
      body: PlaceOrderBody,
      headers: z.object({
        'idempotency-key': z
          .string()
          .min(8)
          .max(255)
          .optional()
          .describe(
            'Optional. A repeat of the same key returns the original response verbatim ' +
              'rather than placing a second order. Enforced by a UNIQUE index, not a lookup.',
          ),
      }),
      response: {
        201: OrderOut,
        200: OrderOut,
        404: ErrorOut,
        409: ErrorOut,
        422: ErrorOut,
      },
    },
    handler: async (request, reply) => {
      const body = request.body;
      const idempotencyKey = request.headers['idempotency-key'];

      /**
       * Claim the key BEFORE doing any work.
       *
       * One `INSERT ... ON CONFLICT DO NOTHING RETURNING id` decides who owns
       * this request. The naive alternative — SELECT, then work, then INSERT —
       * is Phase 1's lost-update race wearing different clothes: two concurrent
       * retries both find nothing, both place an order, and the customer is
       * charged twice. No isolation level prevents it, because nothing in the
       * database knows the two requests are related until after both have
       * already done the work.
       */
      let claimedKeyId: bigint | undefined;

      if (idempotencyKey !== undefined) {
        const outcome = await timed(request, () =>
          claim(app.pool, {
            route: 'POST /v1/orders',
            key: idempotencyKey,
            requestHash: hashRequest(body),
            naive: request.ctx.flags.naiveIdempotency,
          }),
        );

        switch (outcome.status) {
          case 'replay': {
            /**
             * The original response, verbatim.
             *
             * 200 rather than the recorded 201: the resource was created by the
             * *first* request, not this one, and a 201 here would tell the client
             * it had just created something. The recorded body is byte-identical
             * either way, which is the property that matters.
             */
            reply.status(200);
            return outcome.responseBody as never;
          }

          case 'in_progress':
            // 409, not 200. The first request may still fail, so reporting
            // success would be a lie the client acts on.
            reply.status(409);
            return {
              error: 'request_in_progress',
              message: 'a request with this Idempotency-Key is still being processed',
            };

          case 'mismatch':
            reply.status(422);
            return {
              error: 'idempotency_key_reused',
              message:
                'this Idempotency-Key was used with a different request body; ' +
                'replaying an unrelated response would hide the bug',
            };

          case 'claimed':
            claimedKeyId = outcome.id;
            break;
        }
      }

      try {
        const result = await timed(request, () =>
          placeOrder(app.pool, {
            externalId: body.externalId,
            cashAccountExternalId: body.accountId,
            symbol: body.symbol,
            side: body.side,
            quantity: body.quantity,
            mode: request.ctx.flags.concurrencyMode,
          }),
        );

        // Surfaced on the canonical log line, so a run's retry rate is
        // observable without a separate metrics pipeline.
        request.ctx.retryCount = result.attempts - 1;

        switch (result.status) {
          case 'placed': {
            const o = result.order;
            const payload = {
              externalId: o.externalId,
              symbol: o.symbol,
              side: o.side,
              quantity: formatQuantity(o.quantity),
              price: formatCash(o.price),
              notional: formatCash(o.notional),
              status: 'pending' as const,
              transactionId: o.transactionId.toString(),
              cashBalanceAfter: formatCash(o.cashBalanceAfter),
              assetBalanceAfter: formatQuantity(o.assetBalanceAfter),
              attempts: result.attempts,
            };

            if (claimedKeyId !== undefined && idempotencyKey !== undefined) {
              await settle(app.pool, claimedKeyId, {
                state: 'completed',
                responseStatus: 201,
                responseBody: payload,
                // The naive path has no row yet; settle inserts it, after the
                // work. That ordering IS the bug it demonstrates.
                naiveKey: {
                  route: 'POST /v1/orders',
                  key: idempotencyKey,
                  requestHash: hashRequest(body),
                },
              });
            }

            reply.status(201);
            return payload;
          }

          case 'insufficient_funds':
            // 422: well-formed, resource exists, state cannot satisfy it. A load
            // harness must be able to tell this from a 404 and a 500 without
            // parsing a body.
            reply.status(422);
            return {
              error: 'insufficient_funds',
              message: 'the account cannot cover this order',
              available: formatCash(result.available),
              required: formatCash(result.required),
            };

          case 'quantity_rounds_to_zero':
            reply.status(422);
            return {
              error: 'quantity_rounds_to_zero',
              message: `${formatQuantity(result.quantity)} at ${formatCash(result.price)} rounds to 0.00`,
            };

          case 'unknown_instrument':
            reply.status(404);
            return { error: 'unknown_instrument', message: `no instrument ${body.symbol}` };

          case 'unknown_account':
            reply.status(404);
            return {
              error: 'unknown_account',
              message: `no cash account ${body.accountId}, or no ${body.symbol} position account for it`,
            };

          case 'duplicate_external_id':
            reply.status(409);
            return { error: 'duplicate_order', message: `order ${body.externalId} already exists` };
        }
      } catch (err) {
        const code = sqlstateOf(err);
        request.ctx.sqlstate = code ?? null;

        // The unique index on orders.external_id decided this, not a prior
        // SELECT. Phase 4 replaces this with a proper Idempotency-Key, where a
        // repeat returns the original result rather than a conflict.
        if (code === UNIQUE_VIOLATION) {
          reply.status(409);
          return { error: 'duplicate_order', message: `order ${body.externalId} already exists` };
        }
        throw err;
      }
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/instruments',
    schema: {
      tags: ['orders'],
      summary: 'The fixed asset list and the reference prices orders are priced at.',
      response: {
        200: z.array(
          z.object({
            symbol: z.string(),
            displayName: z.string(),
            referencePrice: CashAmountOut,
            referencePriceAt: z.string(),
          }),
        ),
      },
    },
    handler: async (request) => {
      const { rows } = await timed(request, () =>
        app.pool.query<{
          symbol: string;
          display_name: string;
          reference_price: bigint;
          reference_price_at: string;
        }>(
          `SELECT symbol, display_name, reference_price, reference_price_at
             FROM instruments ORDER BY symbol`,
        ),
      );

      return rows.map((r) => ({
        symbol: r.symbol,
        displayName: r.display_name,
        referencePrice: formatCash(r.reference_price),
        referencePriceAt: r.reference_price_at,
      }));
    },
  });
};
