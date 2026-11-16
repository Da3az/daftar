import { z } from 'zod';
import { formatCash } from '@daftar/money';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { timed } from '../plugins/request-context.ts';
import { CashAmountOut, ExternalId, PositiveCashAmount } from '../contracts/money.ts';
import { debit, type DebitStrategy } from '../ledger/naive.ts';

const ACCOUNT_KINDS = [
  'customer_cash',
  'customer_asset',
  'house_cash',
  'house_asset',
  'external_funding',
] as const;

const AccountOut = z.object({
  externalId: ExternalId,
  kind: z.enum(ACCOUNT_KINDS),
  assetSymbol: z.string().nullable(),
  balance: CashAmountOut,
  createdAt: z.string(),
});

const CreateAccountBody = z.object({
  externalId: ExternalId,
  kind: z.enum(ACCOUNT_KINDS),
  assetSymbol: z.string().min(1).max(16).nullish(),
  /** Opening balance. Phase 1 only — real money arrives via a funding webhook. */
  openingBalance: PositiveCashAmount.optional(),
});

const DebitBody = z.object({
  amount: PositiveCashAmount,
});

const DebitOut = z.object({
  status: z.enum(['applied', 'insufficient_funds']),
  strategy: z.enum(['naive_overdraft', 'naive_lost_update', 'guarded_atomic']),
  balanceBefore: CashAmountOut,
  balanceAfter: CashAmountOut,
});

const ErrorOut = z.object({ error: z.string(), message: z.string() });

/**
 * Which debit implementation a request gets.
 *
 * The naive flags take precedence over the strategy, and `naive_overdraft` wins
 * if both are set — a request that asks for two broken paths at once gets one of
 * them deterministically rather than an arbitrary mix.
 *
 * Phase 3 replaces `guarded_atomic` with the real double-entry write path and
 * routes on `concurrencyMode`. The two naive branches stay exactly as they are:
 * they are deliverables.
 */
function strategyFor(flags: { naiveOverdraft: boolean; naiveLostUpdate: boolean }): DebitStrategy {
  if (flags.naiveOverdraft) return 'naive_overdraft';
  if (flags.naiveLostUpdate) return 'naive_lost_update';
  return 'guarded_atomic';
}

export const accountRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: 'POST',
    url: '/v1/accounts',
    schema: {
      tags: ['accounts'],
      summary: 'Create an account.',
      body: CreateAccountBody,
      response: { 201: AccountOut, 409: ErrorOut },
    },
    handler: async (request, reply) => {
      const { externalId, kind, assetSymbol, openingBalance } = request.body;

      try {
        const { rows } = await timed(request, () =>
          app.pool.query<{
            external_id: string;
            kind: (typeof ACCOUNT_KINDS)[number];
            asset_symbol: string | null;
            balance: bigint;
            created_at: string;
          }>(
            `INSERT INTO accounts (external_id, kind, asset_symbol, balance)
             VALUES ($1, $2, $3, $4::bigint)
             RETURNING external_id, kind, asset_symbol, balance, created_at`,
            [externalId, kind, assetSymbol ?? null, (openingBalance ?? 0n).toString()],
          ),
        );

        const row = rows[0]!;
        reply.status(201);
        return {
          externalId: row.external_id,
          kind: row.kind,
          assetSymbol: row.asset_symbol,
          balance: formatCash(row.balance),
          createdAt: row.created_at,
        };
      } catch (err) {
        const sqlstate = (err as { code?: string }).code;
        request.ctx.sqlstate = sqlstate ?? null;

        // 23505 unique_violation — the database decided, not a prior SELECT.
        if (sqlstate === '23505') {
          reply.status(409);
          return { error: 'account_exists', message: `account ${externalId} already exists` };
        }
        // 23514 check_violation — asset/symbol pairing.
        if (sqlstate === '23514') {
          reply.status(409);
          return {
            error: 'invalid_account',
            message: 'asset accounts require an assetSymbol; cash accounts must not have one',
          };
        }
        throw err;
      }
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/accounts/:externalId',
    schema: {
      tags: ['accounts'],
      summary: 'Read an account and its stored balance.',
      params: z.object({ externalId: ExternalId }),
      response: { 200: AccountOut, 404: ErrorOut },
    },
    handler: async (request, reply) => {
      const { rows } = await timed(request, () =>
        app.pool.query<{
          id: bigint;
          external_id: string;
          kind: (typeof ACCOUNT_KINDS)[number];
          asset_symbol: string | null;
          balance: bigint;
          created_at: string;
        }>(
          `SELECT id, external_id, kind, asset_symbol, balance, created_at
             FROM accounts WHERE external_id = $1`,
          [request.params.externalId],
        ),
      );

      const row = rows[0];
      if (!row) {
        reply.status(404);
        return { error: 'not_found', message: `no account ${request.params.externalId}` };
      }

      request.ctx.accountId = row.id;

      return {
        externalId: row.external_id,
        kind: row.kind,
        assetSymbol: row.asset_symbol,
        balance: formatCash(row.balance),
        createdAt: row.created_at,
      };
    },
  });

  app.route({
    method: 'POST',
    url: '/v1/accounts/:externalId/debits',
    schema: {
      tags: ['ledger'],
      summary: 'Debit cash from an account.',
      description: [
        'The Phase 1 measured write path. Which implementation runs is chosen',
        'per request:',
        '',
        '- `x-daftar-naive-overdraft: true` — application funds check, then an',
        '  atomic `balance = balance - $1`. Produces **overdrafts** and',
        '  **zero lost updates**: the self-referential UPDATE is re-evaluated',
        '  against the committed row version under READ COMMITTED, so the final',
        '  balance is arithmetically exact, just negative.',
        '- `x-daftar-naive-lost-update: true` — read, compute in application code,',
        '  write an absolute value. **Loses updates**, so the final balance is',
        '  higher than it should be and money is created from nothing.',
        '- neither — a single guarded statement',
        '  (`... WHERE balance >= $1`). Correct.',
        '',
        'Both naive paths are permanent, documented deliverables.',
      ].join('\n'),
      params: z.object({ externalId: ExternalId }),
      body: DebitBody,
      response: { 200: DebitOut, 404: ErrorOut, 422: DebitOut },
    },
    handler: async (request, reply) => {
      const strategy = strategyFor(request.ctx.flags);
      const { amount } = request.body;

      const client = await app.pool.connect();
      try {
        const lookup = await timed(request, () =>
          client.query<{ id: bigint }>('SELECT id FROM accounts WHERE external_id = $1', [
            request.params.externalId,
          ]),
        );

        const accountId = lookup.rows[0]?.id;
        if (accountId === undefined) {
          reply.status(404);
          return { error: 'not_found', message: `no account ${request.params.externalId}` };
        }

        request.ctx.accountId = accountId;

        const outcome = await timed(request, () => debit(client, { accountId, amount, strategy }));

        if (outcome.status === 'no_such_account') {
          reply.status(404);
          return { error: 'not_found', message: `no account ${request.params.externalId}` };
        }

        if (outcome.status === 'insufficient_funds') {
          // 422 and not 409: the request was well-formed and the resource
          // exists; the account state cannot satisfy it. A load harness needs to
          // tell this apart from a 404 and from a 500 without parsing a body.
          reply.status(422);
          return {
            status: 'insufficient_funds' as const,
            strategy,
            balanceBefore: formatCash(outcome.balanceBefore),
            balanceAfter: formatCash(outcome.balanceBefore),
          };
        }

        return {
          status: 'applied' as const,
          strategy,
          balanceBefore: formatCash(outcome.balanceBefore),
          balanceAfter: formatCash(outcome.balanceAfter),
        };
      } finally {
        client.release();
      }
    },
  });
};
