import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { describeFlags, resolveFlags, type RequestFlags } from '../flags.ts';
import { traceIds } from './metrics.ts';

/**
 * Per-request mutable accumulator for the canonical log line.
 *
 * Deliberately a plain object hung off the request rather than AsyncLocalStorage:
 * every writer already has the request in hand, and ALS has a measurable cost on
 * a path whose p99 is the headline number of this repo. If a future code path
 * genuinely cannot reach the request, that is the moment to reconsider — not
 * before.
 */
export interface RequestContext {
  /** Monotonic start, for total duration. Not Date.now(): that can step backwards. */
  readonly startedAt: number;

  readonly flags: RequestFlags;

  /** Which account the request acted on, when there is exactly one. */
  accountId: bigint | null;

  /** Cumulative milliseconds spent waiting on the database. */
  dbMs: number;

  /** Number of database statements issued. Spots an accidental N+1. */
  dbCalls: number;

  /**
   * Retries of the whole ledger transaction. Non-zero only under
   * `serializable`, and the thing that makes its trade-off visible rather than
   * asserted.
   */
  retryCount: number;

  /**
   * The PostgreSQL SQLSTATE of the last database error, if any. Kept distinct
   * from the HTTP status because 40001 (serialization_failure) and 40P01
   * (deadlock_detected) can both surface as the same 409, and telling them apart
   * is the whole point of Phase 3's deadlock test.
   */
  sqlstate: string | null;

  /** True once the canonical line has been written, so it is written exactly once. */
  logged: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

/** Accumulate database timing. Called by the query helpers, not by handlers. */
export function recordDbTime(request: FastifyRequest, elapsedMs: number): void {
  request.ctx.dbMs += elapsedMs;
  request.ctx.dbCalls += 1;
}

/**
 * Time one database operation into the request context.
 *
 * `performance.now()` rather than `Date.now()` — a clock step during a benchmark
 * run would otherwise produce negative durations, and a negative p99 is the kind
 * of number that invalidates a whole evidence file.
 */
export async function timed<T>(request: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    recordDbTime(request, performance.now() - started);
  }
}

export const requestContextPlugin = fp(
  // fastify-plugin accepts an async function or a (app, opts, done) callback.
  // Async with no await is the clearer of the two; see the require-await
  // override for plugin and route files in eslint.config.js.
  async (app) => {
    /*
     * Single-argument form: reserve the property name without a value. Fastify 5
     * deliberately does not let you give a request decorator a shared object
     * default — every request would get the *same* object, and here that would
     * mean two concurrent requests accumulating `dbMs` into one accumulator.
     * Reserving the name keeps the hidden-class shape stable; `onRequest`
     * assigns the per-request instance.
     */
    app.decorateRequest('ctx');

    app.addHook('onRequest', (request, _reply, done) => {
      request.ctx = {
        startedAt: performance.now(),
        // resolveFlags can throw on a malformed header. Letting it throw here —
        // the earliest hook — means a bad flag header never reaches a handler
        // that would then run with default flags and look like it passed.
        flags: resolveFlags(request.headers),
        accountId: null,
        dbMs: 0,
        dbCalls: 0,
        retryCount: 0,
        sqlstate: null,
        logged: false,
      };
      done();
    });

    {
      /**
       * The canonical log line. Exactly one per request, carrying everything
       * needed to reconstruct what happened without joining to another record.
       *
       * `onResponse` fires for every request that produced a response, including
       * those that went through the error handler, so this is the outermost
       * `finally` in Fastify's lifecycle. `onRequestAbort` covers the client
       * hanging up before a response — which, under a load test that kills
       * in-flight requests at the end of a run, is otherwise a silent gap in the
       * numbers.
       */
      const emit = (request: FastifyRequest, status: number, aborted: boolean): void => {
        if (request.ctx.logged) return;
        request.ctx.logged = true;

        const ctx = request.ctx;
        // `request_id` is contributed by Fastify's child logger bindings
        // (requestIdLogLabel is set to 'request_id' in app.ts), so it is not
        // repeated here.
        request.log.info(
          {
            method: request.method,
            route: request.routeOptions.url ?? request.url,
            status,
            aborted,
            duration_ms: Math.round((performance.now() - ctx.startedAt) * 1000) / 1000,
            db_ms: Math.round(ctx.dbMs * 1000) / 1000,
            db_calls: ctx.dbCalls,
            retry_count: ctx.retryCount,
            sqlstate: ctx.sqlstate,
            account_id: ctx.accountId,
            mode: describeFlags(ctx.flags),
            // Present whether or not the span was sampled, so an unsampled
            // failure is still correlatable. See plugins/metrics.ts.
            ...traceIds(),
          },
          'request',
        );
      };

      app.addHook('onResponse', (request, reply, done) => {
        emit(request, reply.statusCode, false);
        done();
      });

      app.addHook('onRequestAbort', (request, done) => {
        emit(request, 499, true);
        done();
      });
    }
  },
  { name: 'request-context' },
);
