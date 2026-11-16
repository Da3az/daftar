import { z } from 'zod';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { isBigIntTypeParserRegistered } from '../db/bigint.ts';
import { timed } from '../plugins/request-context.ts';

const LiveResponse = z.object({
  status: z.literal('ok'),
  /** Seconds since process start, as a number — this is not money. */
  uptimeSeconds: z.number(),
});

const ReadyResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({
    database: z.boolean(),
    bigintTypeParser: z.boolean(),
  }),
  /**
   * Proof, on every readiness check, that `int8` round-trips as a `bigint` and
   * not a string. Returned as an exact decimal string — the wire format for
   * every amount in this API — alongside the runtime `typeof` the server saw.
   *
   * This is not decoration. The one-character regression that reintroduces
   * `"100" + "50" === "10050"` is invisible in every unit test that mocks the
   * driver, so the liveness surface asserts it against the real database.
   */
  int8Probe: z
    .object({
      value: z.string(),
      runtimeType: z.string(),
    })
    .nullable(),
});

/** 2^63 - 1: the largest value an int8 column can hold. */
const INT8_MAX = '9223372036854775807';

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: 'GET',
    url: '/health/live',
    schema: {
      tags: ['health'],
      summary: 'Liveness — the process is up. Touches nothing external.',
      response: { 200: LiveResponse },
    },
    handler: () => ({ status: 'ok' as const, uptimeSeconds: process.uptime() }),
  });

  app.route({
    method: 'GET',
    url: '/health/ready',
    schema: {
      tags: ['health'],
      summary: 'Readiness — the database answers and int8 arrives as a bigint.',
      response: { 200: ReadyResponse, 503: ReadyResponse },
    },
    handler: async (request, reply) => {
      const bigintTypeParser = isBigIntTypeParserRegistered();

      let database = false;
      let int8Probe: { value: string; runtimeType: string } | null = null;

      try {
        const result = await timed(request, () =>
          app.pool.query<{ probe: bigint }>(`SELECT ${INT8_MAX}::bigint AS probe`),
        );
        const probe = result.rows[0]?.probe;
        database = true;
        int8Probe = {
          // String(1n) is "1" — no "n" suffix — so this is the exact decimal
          // value even when the driver handed back a bigint.
          value: String(probe),
          runtimeType: typeof probe,
        };
      } catch (err) {
        request.ctx.sqlstate = (err as { code?: string }).code ?? null;
      }

      const healthy = database && bigintTypeParser && int8Probe?.runtimeType === 'bigint';

      reply.status(healthy ? 200 : 503);
      return {
        status: healthy ? ('ok' as const) : ('degraded' as const),
        checks: { database, bigintTypeParser },
        int8Probe,
      };
    },
  });
};
