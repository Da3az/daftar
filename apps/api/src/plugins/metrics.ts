import fp from 'fastify-plugin';
import { trace } from '@opentelemetry/api';
import {
  httpDuration,
  ledgerRetries,
  metricsContentType,
  metricsText,
  outboxGauge,
  poolGauge,
  statusClass,
} from '../observability/metrics.ts';

/**
 * Metrics collection and the `/metrics` endpoint.
 *
 * Registered after `requestContextPlugin`, so the request context — and
 * therefore `retry_count`, `sqlstate` and the resolved mode — already exists by
 * the time the `onResponse` hook here runs.
 */
export const metricsPlugin = fp(
  async (app) => {
    app.addHook('onResponse', (request, reply, done) => {
      const route = request.routeOptions.url ?? 'unmatched';

      // Never the resolved URL: `/v1/accounts/seed-000001` would put an account
      // id in a metric label, which is the cardinality-and-leak rule this repo
      // is explicit about.
      httpDuration.observe(
        { route, method: request.method, status: statusClass(reply.statusCode) },
        (performance.now() - request.ctx.startedAt) / 1000,
      );

      /**
       * Retries are attributed to the SQLSTATE that caused them, which is the
       * whole point of the metric: 40001 and 40P01 mean different things and
       * differ in cost by three orders of magnitude.
       *
       * `'unknown'` when a retry happened but no SQLSTATE was recorded — a
       * bucket that should stay empty, and is worth seeing if it does not.
       */
      if (request.ctx.retryCount > 0) {
        ledgerRetries.inc(
          { sqlstate: request.ctx.sqlstate ?? 'unknown', mode: request.ctx.flags.concurrencyMode },
          request.ctx.retryCount,
        );
      }

      done();
    });

    /**
     * Pool stats are sampled on scrape rather than tracked on every
     * acquire/release. `pg.Pool` already maintains the three counters; mirroring
     * them with our own would be a second source of truth that can drift.
     */
    app.get(
      '/metrics',
      {
        // Excluded from the OpenAPI document: it is an operational endpoint
        // with a non-JSON content type, and putting it in the published API
        // contract invites someone to treat it as one.
        schema: { hide: true },
        config: { rateLimit: false },
      },
      async (_request, reply) => {
        poolGauge.set({ state: 'total' }, app.pool.totalCount);
        poolGauge.set({ state: 'idle' }, app.pool.idleCount);
        poolGauge.set({ state: 'waiting' }, app.pool.waitingCount);

        /**
         * Outbox depth comes from the database, not from process memory: the
         * queue is a property of the data, and an in-process counter would be
         * per-instance and would reset on deploy.
         *
         * Wrapped so a database hiccup degrades the scrape rather than failing
         * it — losing the outbox gauges is much better than losing every metric
         * including the ones that would explain the hiccup.
         */
        try {
          const { rows } = await app.pool.query<{
            pending: bigint;
            in_flight: bigint;
            dead: bigint;
            oldest_unpublished_seconds: bigint;
            stale_claims: bigint;
          }>('SELECT * FROM outbox_lag');

          const r = rows[0];
          if (r) {
            outboxGauge.set({ metric: 'pending' }, Number(r.pending));
            outboxGauge.set({ metric: 'in_flight' }, Number(r.in_flight));
            outboxGauge.set({ metric: 'dead' }, Number(r.dead));
            outboxGauge.set({ metric: 'stale_claims' }, Number(r.stale_claims));
            outboxGauge.set(
              { metric: 'oldest_unpublished_seconds' },
              Number(r.oldest_unpublished_seconds),
            );
          }
        } catch (err) {
          app.log.warn({ err }, 'outbox gauges unavailable for this scrape');
        }

        reply.header('content-type', metricsContentType);
        return metricsText();
      },
    );
  },
  { name: 'metrics', dependencies: ['request-context'] },
);

/**
 * The current trace and span ids, for the canonical log line.
 *
 * This is what makes an **unsampled** failure findable. Head sampling cannot
 * decide on error (see observability/tracing.ts), so at a 2% ratio most errors
 * have no waterfall. Putting the ids on every log line means the failure is
 * still correlatable by log search, and if the trace *was* sampled the id links
 * straight to it.
 *
 * Returns nulls when tracing is disabled, rather than omitting the keys, so the
 * canonical line has one stable shape.
 */
export function traceIds(): { trace_id: string | null; span_id: string | null } {
  const span = trace.getActiveSpan();
  if (!span) return { trace_id: null, span_id: null };

  const ctx = span.spanContext();
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}
