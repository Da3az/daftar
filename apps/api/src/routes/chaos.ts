import { z } from 'zod';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { env, LEDGER_CONCURRENCY_MODES } from '../env.ts';
import { timed } from '../plugins/request-context.ts';
import {
  MAX_ACCOUNT_SPREAD,
  MAX_VIRTUAL_USERS,
  TOKEN_TTL_SECONDS,
  issue,
  verify,
} from '../chaos/session.ts';
import { runBurst, type BurstProfile } from '../chaos/burst.ts';

/**
 * # The chaos panel's server side
 *
 * Two endpoints. `POST /v1/chaos/session` hands out a short-lived token and a
 * private demo tenant; `POST /v1/chaos/burst` spends it.
 *
 * Both carry a rate limit far tighter than the global one, declared per route
 * rather than relying on the global default — the global limit is raised to
 * 200,000 for benchmark runs (see the note in app.ts), and a burst endpoint
 * inheriting that would be inheriting no limit at all.
 */

const NAIVE_STRATEGIES = ['naive_overdraft', 'naive_lost_update', 'guarded_atomic'] as const;

const SessionOut = z.object({
  token: z.string(),
  tenant: z.string(),
  expiresAt: z.number().int().describe('Unix seconds.'),
  ttlSeconds: z.number().int(),
  limits: z.object({
    maxVirtualUsers: z.number().int(),
    maxAccountSpread: z.number().int(),
  }),
});

const BurstBody = z.object({
  /**
   * Either a concurrency strategy for the real order path, or a naive debit
   * strategy. Exactly one — a union rather than two optional fields, so
   * "both" and "neither" are not expressible.
   *
   * ## `.strict()` matters here specifically
   *
   * Zod strips unknown keys by default, so without it
   * `{ kind: 'order', mode: 'advisory', strategy: 'naive_overdraft' }` is
   * accepted — `strategy` is silently dropped and the **correct** path runs.
   * The user then reads a clean invariant report and concludes that
   * `naive_overdraft` is safe.
   *
   * That is the worst possible failure for this endpoint. Its entire purpose is
   * to tell the truth about which code path ran, so a request that is confused
   * about which one it wants is a 400.
   */
  profile: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('order'), mode: z.enum(LEDGER_CONCURRENCY_MODES) }).strict(),
    z.object({ kind: z.literal('debit'), strategy: z.enum(NAIVE_STRATEGIES) }).strict(),
  ]),
  /**
   * Bounded by the schema, so an over-large value is a 400 rather than being
   * silently clamped. A client that asks for 10,000 virtual users has a bug,
   * and clamping hides it.
   */
  virtualUsers: z.coerce.number().int().min(1).max(MAX_VIRTUAL_USERS).default(50),
  accountSpread: z.coerce.number().int().min(1).max(MAX_ACCOUNT_SPREAD).default(10),
});

const InvariantsOut = z.object({
  entriesSumToZeroPerUnit: z.boolean(),
  unitSums: z.array(z.object({ unit: z.string(), sum: z.string() })),
  overdrawnAccounts: z.array(z.object({ externalId: z.string(), balance: z.string() })),
  overdraftOccurred: z.boolean(),
  /**
   * `null` for the naive `debit` profiles, which write no ledger entries at
   * all — comparing a balance to an entries sum of zero would report a drift
   * finding where there is simply no ledger. See `BurstInvariants`.
   */
  balanceMatchesEntries: z.boolean().nullable(),
  drift: z.array(z.object({ externalId: z.string(), balance: z.string(), entriesSum: z.string() })),
  expectedCash: z.string().nullable(),
  actualCash: z.string().nullable(),
  cashDiscrepancy: z.string().nullable(),
});

const BurstOut = z.object({
  tenant: z.string(),
  profile: z.unknown(),
  virtualUsers: z.number().int(),
  accountSpread: z.number().int(),
  attempted: z.number().int(),
  succeeded: z.number().int(),
  refused: z.number().int(),
  errored: z.number().int(),
  totalAttempts: z.number().int(),
  serializationFailures: z.number().int(),
  deadlocks: z.number().int(),
  durationMs: z.number(),
  throughput: z.number(),
  openingPerAccount: z.string(),
  invariants: InvariantsOut,
});

const ErrorOut = z.object({ error: z.string(), message: z.string() });

export const chaosRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: 'POST',
    url: '/v1/chaos/session',
    config: {
      /**
       * 10 per minute per IP by default. A visitor needs one; a script
       * harvesting tokens to build a burst army needs many.
       */
      rateLimit: { max: env.CHAOS_SESSION_RATE_MAX, timeWindow: 60_000 },
    },
    schema: {
      tags: ['chaos'],
      summary: 'Issue a short-lived burst token and a private demo tenant.',
      description: [
        'The token is an HMAC over its own contents — no sessions table, so',
        'nothing to clean up and a restart does not invalidate a token',
        'mid-demo. It cannot be revoked before it expires, which is an',
        'acceptable trade at a 15-minute lifetime for an endpoint whose worst',
        'case is already capped.',
        '',
        '**Not a static key.** A key shipped in a JavaScript bundle is a public',
        'key with extra steps.',
        '',
        'The `tenant` namespaces every account the burst touches. Demo writes',
        'never mix with the seeded data — a burst is *supposed* to cause',
        'overdrafts under a naive flag, and doing that to a measured account',
        'would corrupt the dataset every benchmark was taken against.',
      ].join('\n'),
      response: { 201: SessionOut },
    },
    handler: async (_request, reply) => {
      const { token, session } = issue(env.CHAOS_TOKEN_SECRET);

      reply.status(201);
      return {
        token,
        tenant: session.tenant,
        expiresAt: session.expiresAt,
        ttlSeconds: TOKEN_TTL_SECONDS,
        limits: {
          maxVirtualUsers: MAX_VIRTUAL_USERS,
          maxAccountSpread: MAX_ACCOUNT_SPREAD,
        },
      };
    },
  });

  app.route({
    method: 'POST',
    url: '/v1/chaos/burst',
    config: {
      /**
       * 6 per minute per IP by default. One burst is up to 200 concurrent
       * transactions, so this is the real cap on what a single visitor can
       * make the database do — and it is declared here rather than inherited,
       * because the global limit is raised to six figures for benchmark runs.
       *
       * Per IP *and* token-gated: the token stops a drive-by, the IP limit
       * stops someone who fetched a token first.
       */
      rateLimit: { max: env.CHAOS_BURST_RATE_MAX, timeWindow: 60_000 },
    },
    schema: {
      tags: ['chaos'],
      summary: 'Fire N concurrent ledger writes server-side and check the invariants.',
      description: [
        '**The concurrency happens here, not in the browser.** A browser caps',
        'at 6 connections per origin on HTTP/1.1 and runs one JavaScript',
        'thread, so a `Promise.all` of 200 `fetch` calls from a page is a queue',
        'of 6. The database would see six overlapping transactions, every',
        'invariant would hold comfortably, and the panel would be showing the',
        'ledger surviving load that never happened — which would quietly',
        'discredit every measured number in this repo.',
        '',
        'Runs the **real** write path: `placeOrder` under the chosen strategy,',
        'or one of the Phase 1 naive debit paths. Not a simulation.',
        '',
        'Caps are enforced server-side and an over-large request is a 400, not',
        'a clamp — a client asking for 10,000 virtual users has a bug, and',
        'clamping hides it.',
      ].join('\n'),
      headers: z.object({
        'x-daftar-chaos-token': z.string().min(1).describe('From POST /v1/chaos/session.'),
      }),
      body: BurstBody,
      response: { 200: BurstOut, 401: ErrorOut, 429: ErrorOut },
    },
    handler: async (request, reply) => {
      const result = verify(env.CHAOS_TOKEN_SECRET, request.headers['x-daftar-chaos-token']);

      if (!result.valid) {
        /*
         * One status and one generic message for all three reasons. Telling a
         * caller that their signature was fine but the token had expired is a
         * small oracle, and there is nothing a legitimate client does
         * differently between the cases — it fetches a new token either way.
         * The specific reason goes to the log.
         */
        app.log.warn({ reason: result.reason }, 'chaos token rejected');
        reply.status(401);
        return {
          error: 'invalid_chaos_token',
          message: 'missing, malformed or expired token — request a new session',
        };
      }

      const profile: BurstProfile =
        request.body.profile.kind === 'order'
          ? { kind: 'order', mode: request.body.profile.mode }
          : { kind: 'debit', strategy: request.body.profile.strategy };

      const burst = await timed(request, () =>
        runBurst(app.pool, {
          tenant: result.session.tenant,
          profile,
          virtualUsers: request.body.virtualUsers,
          accountSpread: request.body.accountSpread,
        }),
      );

      /*
       * Logged at warn when an invariant failed, so a chaos run that breaks the
       * ledger is findable in the logs afterwards and not only in a browser tab
       * that has since been closed.
       */
      if (
        !burst.invariants.entriesSumToZeroPerUnit ||
        burst.invariants.balanceMatchesEntries === false
      ) {
        app.log.warn(
          {
            tenant: result.session.tenant,
            profile,
            sums_to_zero: burst.invariants.entriesSumToZeroPerUnit,
            balance_matches: burst.invariants.balanceMatchesEntries,
            drift_accounts: burst.invariants.drift.length,
          },
          'chaos burst violated a ledger invariant',
        );
      }

      return { tenant: result.session.tenant, ...burst };
    },
  });
};
