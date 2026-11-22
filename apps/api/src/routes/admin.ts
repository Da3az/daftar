import { z } from 'zod';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { rejectUnlessAdmin } from '../plugins/admin.ts';

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
};
