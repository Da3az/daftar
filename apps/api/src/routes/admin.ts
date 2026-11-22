import { z } from 'zod';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { rejectUnlessAdmin } from '../plugins/admin.ts';
import { getRailChaos, setRailChaos } from '../exchange/rail.ts';
import {
  approve,
  getWithdrawal,
  listForReview,
  release,
  transitionsOf,
} from '../exchange/withdrawals.ts';
import { WithdrawalOut, withdrawalOut } from './exchange-withdrawals.ts';

/**
 * # Admin routes
 *
 * Behind `ADMIN_TOKEN` (see `plugins/admin.ts`). Nothing here moves money.
 */

const AdminError = z.object({ error: z.string(), message: z.string() });

const DriftBody = z
  .object({
    /** The guest's public handle, never an internal id. */
    handle: z.string().min(1).max(64),
    symbol: z.string().min(1).max(16).default('DFT'),
    field: z.enum(['quantity', 'cost_basis']),
    /** Minor units (cost) or 1e-8 units (quantity). Non-zero. */
    delta: z
      .string()
      .regex(/^-?[0-9]{1,18}$/)
      .refine((v) => BigInt(v) !== 0n, 'delta must be non-zero'),
  })
  .strict();

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: 'POST',
    url: '/v1/admin/chaos/projection-drift',
    schema: {
      tags: ['admin'],
      summary:
        'Corrupt one projected position on purpose, to measure how long the reconciler takes to notice.',
      description:
        'Changes `proj_positions` directly — never the ledger — and records the injection time. ' +
        'The reconciler finding that follows carries that time as `introduced_at`, so ' +
        '`detected_at − introduced_at` is the time-to-detect.',
      body: DriftBody,
      response: {
        200: z.object({ injectionId: z.string(), injectedAt: z.string() }),
        401: AdminError,
        404: AdminError,
      },
    },
    handler: async (request, reply) => {
      if (rejectUnlessAdmin(request, reply)) return reply;
      const { handle, symbol, field, delta } = request.body;

      const client = await app.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: who } = await client.query<{ id: bigint }>(
          `SELECT id FROM participants WHERE handle = $1 AND kind = 'guest'`,
          [handle],
        );
        const participantId = who[0]?.id;
        if (participantId === undefined) {
          await client.query('ROLLBACK');
          reply.status(404);
          return { error: 'unknown_guest', message: 'no guest with that handle' };
        }

        // The column name comes from a two-value enum above, never from input text.
        const column = field === 'quantity' ? 'quantity' : 'cost_basis';
        const { rowCount } = await client.query(
          `UPDATE proj_positions SET ${column} = greatest(${column} + $3::bigint, 0)
            WHERE participant_id = $1::bigint AND symbol = $2`,
          [participantId.toString(), symbol, delta],
        );
        if ((rowCount ?? 0) === 0) {
          await client.query('ROLLBACK');
          reply.status(404);
          return { error: 'no_position', message: 'that guest has no projected position here' };
        }

        const { rows } = await client.query<{ id: bigint; injected_at: string }>(
          `INSERT INTO projection_drift_injections (participant_id, symbol, field, delta)
           VALUES ($1::bigint, $2, $3, $4::bigint)
           RETURNING id, injected_at`,
          [participantId.toString(), symbol, field, delta],
        );
        await client.query('COMMIT');
        return { injectionId: rows[0]!.id.toString(), injectedAt: rows[0]!.injected_at };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  });

  app.route({
    method: 'GET',
    url: '/v1/admin/reconciliation',
    schema: {
      tags: ['admin'],
      summary: 'Recent reconciler findings, with time-to-detect where the start is known.',
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      response: {
        200: z.object({
          findings: z.array(
            z.object({
              id: z.string(),
              kind: z.string(),
              symbol: z.string().nullable(),
              expected: z.string().nullable(),
              actual: z.string().nullable(),
              detectedAt: z.string(),
              introducedAt: z.string().nullable(),
              timeToDetectMs: z.number().nullable(),
              detail: z.string().nullable(),
            }),
          ),
          deadLetters: z.number().int(),
        }),
        401: AdminError,
        404: AdminError,
      },
    },
    handler: async (request, reply) => {
      if (rejectUnlessAdmin(request, reply)) return reply;
      const { rows } = await app.pool.query<{
        id: bigint;
        kind: string;
        symbol: string | null;
        expected: bigint | null;
        actual: bigint | null;
        detected_at: string;
        introduced_at: string | null;
        ttd_ms: number | null;
        detail: string | null;
      }>(
        `SELECT id, kind, symbol, expected, actual, detected_at, introduced_at,
                (extract(epoch FROM detected_at - introduced_at) * 1000)::float8 AS ttd_ms,
                detail
           FROM reconciliation_findings
          ORDER BY detected_at DESC
          LIMIT $1::int`,
        [request.query.limit],
      );
      const { rows: dead } = await app.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM consumer_dead_letters WHERE resolved_at IS NULL',
      );
      return {
        findings: rows.map((r) => ({
          id: r.id.toString(),
          kind: r.kind,
          symbol: r.symbol,
          expected: r.expected?.toString() ?? null,
          actual: r.actual?.toString() ?? null,
          detectedAt: r.detected_at,
          introducedAt: r.introduced_at,
          timeToDetectMs: r.ttd_ms,
          detail: r.detail,
        })),
        deadLetters: dead[0]!.n,
      };
    },
  });

  /* ------------------------------------------------------ withdrawal review */

  const ReviewItem = WithdrawalOut.extend({ guest: z.string() });

  app.route({
    method: 'GET',
    url: '/v1/admin/withdrawals',
    schema: {
      tags: ['admin'],
      summary: 'Withdrawals that are not finished, those waiting for review first.',
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      response: {
        200: z.object({ withdrawals: z.array(ReviewItem) }),
        401: AdminError,
        404: AdminError,
      },
    },
    handler: async (request, reply) => {
      if (rejectUnlessAdmin(request, reply)) return reply;
      const list = await listForReview(app.pool, request.query.limit);
      const history = await transitionsOf(
        app.pool,
        list.map((w) => w.id),
      );
      const { rows } = await app.pool.query<{ id: bigint; display_name: string }>(
        'SELECT id, display_name FROM participants WHERE id = ANY($1::bigint[])',
        [list.map((w) => w.participantId.toString())],
      );
      const names = new Map(rows.map((r) => [r.id, r.display_name]));
      return {
        withdrawals: list.map((w) => ({
          ...withdrawalOut(w, history.get(w.id) ?? [], null),
          guest: names.get(w.participantId) ?? '—',
        })),
      };
    },
  });

  const Decision = z.object({ id: z.string().regex(/^[0-9]{1,19}$/) });

  app.route({
    method: 'POST',
    url: '/v1/admin/withdrawals/:id/approve',
    schema: {
      tags: ['admin'],
      summary: 'Approve a withdrawal in review: it goes back into the pipeline as held.',
      params: Decision,
      response: {
        200: z.object({ outcome: z.enum(['approved', 'not_in_review']) }),
        401: AdminError,
        404: AdminError,
      },
    },
    handler: async (request, reply) => {
      if (rejectUnlessAdmin(request, reply)) return reply;
      const done = await approve(app.pool, BigInt(request.params.id), 'admin');
      return { outcome: done ? ('approved' as const) : ('not_in_review' as const) };
    },
  });

  app.route({
    method: 'POST',
    url: '/v1/admin/withdrawals/:id/reject',
    schema: {
      tags: ['admin'],
      summary: 'Reject a withdrawal in review: it fails and the cash returns from hold.',
      params: Decision,
      response: {
        200: z.object({ outcome: z.enum(['released', 'not_in_review']) }),
        401: AdminError,
        404: AdminError,
      },
    },
    handler: async (request, reply) => {
      if (rejectUnlessAdmin(request, reply)) return reply;
      const id = BigInt(request.params.id);
      const w = await getWithdrawal(app.pool, id);
      if (!w || w.state !== 'review') return { outcome: 'not_in_review' as const };
      const outcome = await release(app.pool, id, 'rejected on review', 'admin');
      return { outcome: outcome === 'done' ? ('released' as const) : ('not_in_review' as const) };
    },
  });

  /* ---------------------------------------------------------- rail chaos */

  const Chaos = z
    .object({
      timeoutButSucceededPct: z.number().int().min(0).max(100),
      dropPct: z.number().int().min(0).max(100),
      rejectPct: z.number().int().min(0).max(100),
      latencyMs: z.number().int().min(0).max(60_000),
      confirmAfterMs: z.number().int().min(0).max(3_600_000),
    })
    .strict()
    .refine(
      (c) => c.timeoutButSucceededPct + c.dropPct + c.rejectPct <= 100,
      'the three percentages must sum to at most 100',
    );

  app.route({
    method: 'GET',
    url: '/v1/admin/rail-chaos',
    schema: {
      tags: ['admin'],
      summary: "The simulated payout rail's failure knobs.",
      response: { 200: Chaos, 401: AdminError, 404: AdminError },
    },
    handler: async (request, reply) => {
      if (rejectUnlessAdmin(request, reply)) return reply;
      return getRailChaos(app.pool);
    },
  });

  app.route({
    method: 'PUT',
    url: '/v1/admin/rail-chaos',
    schema: {
      tags: ['admin'],
      summary: "Set the simulated payout rail's failure knobs.",
      description:
        'Per submission: `timeoutButSucceededPct` records the payment and then times out, ' +
        '`dropPct` times out without recording it, `rejectPct` records a rejection. ' +
        '`confirmAfterMs` is how long an accepted payment stays pending.',
      body: Chaos,
      response: { 200: Chaos, 401: AdminError, 404: AdminError },
    },
    handler: async (request, reply) => {
      if (rejectUnlessAdmin(request, reply)) return reply;
      await setRailChaos(app.pool, request.body);
      return getRailChaos(app.pool);
    },
  });
};
