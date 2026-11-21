import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * # Prometheus metrics
 *
 * ## The cardinality rule, which is not negotiable
 *
 * **Never label a metric by `account_id`.** Two independent reasons:
 *
 * 1. **Unbounded cardinality.** Prometheus creates one time series per distinct
 *    label combination and holds them all in memory. 4,000 accounts × a handful
 *    of other labels is already tens of thousands of series from one metric; a
 *    real customer base makes it millions and the Prometheus instance dies.
 *    This is the single most common way people destroy a monitoring system.
 * 2. **It is a data leak.** Metrics endpoints are routinely less protected than
 *    the database — scraped over plain HTTP, proxied into a shared Grafana,
 *    readable by anyone with cluster access. `daftar_orders_total{account_id=…}`
 *    publishes who traded and how often.
 *
 * Every label below is a bounded set: three concurrency modes, a handful of
 * SQLSTATEs, a fixed route list, a few outcomes. A label whose value comes from
 * user input or a database id does not belong here.
 *
 * Route labels use the **route pattern** (`/v1/accounts/:externalId`), never the
 * resolved URL, for the same reason.
 */

export const registry = new Registry();

registry.setDefaultLabels({ service: 'daftar-api' });

/**
 * Node's own metrics: heap, GC, handles, and `process_resident_memory_bytes`.
 *
 * The RSS series is the one that matters most here and is called out in
 * `docs/alerting.md`: the alert is on its **slope over days**, not on an
 * absolute value, because a tracing library that leaks a few megabytes an hour
 * never crosses a sensible threshold until it suddenly does.
 */
collectDefaultMetrics({ register: registry, prefix: 'daftar_' });

/**
 * Event-loop delay, from `perf_hooks.monitorEventLoopDelay`.
 *
 * Shipped from day one because it is the one signal that distinguishes "the
 * database is slow" from "the Node process is blocked". A p99 of 200 ms with a
 * flat event loop is a database problem; the same p99 with 150 ms of loop delay
 * is JavaScript doing synchronous work on the request path, and the fixes are
 * nothing alike.
 *
 * `resolution: 10` ms — the histogram's own sampling interval. Finer costs more
 * than the signal is worth.
 */
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

new Gauge({
  name: 'daftar_event_loop_delay_seconds',
  help: 'Event-loop delay percentiles, sampled at 10ms resolution.',
  labelNames: ['quantile'],
  registers: [registry],
  collect() {
    // Nanoseconds from perf_hooks; Prometheus convention is base units.
    this.set({ quantile: 'p50' }, loopDelay.percentile(50) / 1e9);
    this.set({ quantile: 'p99' }, loopDelay.percentile(99) / 1e9);
    this.set({ quantile: 'max' }, loopDelay.max / 1e9);
  },
});

/**
 * `process.memoryUsage()` broken out, rather than only the single RSS number
 * that `collectDefaultMetrics` provides.
 *
 * The breakout is what makes a leak diagnosable. `heapUsed` growing is a
 * JavaScript leak. `external` growing with a flat heap is Buffers or a native
 * addon — which is where an OpenTelemetry instrumentation leak would show up,
 * and is invisible if you only watch the heap. `rss` growing with both flat is
 * fragmentation or the allocator.
 */
new Gauge({
  name: 'daftar_memory_bytes',
  help: 'process.memoryUsage(), broken out. rss / heapUsed / heapTotal / external / arrayBuffers.',
  labelNames: ['kind'],
  registers: [registry],
  collect() {
    const m = process.memoryUsage();
    this.set({ kind: 'rss' }, m.rss);
    this.set({ kind: 'heapUsed' }, m.heapUsed);
    this.set({ kind: 'heapTotal' }, m.heapTotal);
    this.set({ kind: 'external' }, m.external);
    this.set({ kind: 'arrayBuffers' }, m.arrayBuffers);
  },
});

/** HTTP request duration. Route *pattern*, never the resolved URL. */
export const httpDuration = new Histogram({
  name: 'daftar_http_request_duration_seconds',
  help: 'Request duration by route pattern, method and status class.',
  labelNames: ['route', 'method', 'status'],
  /**
   * Buckets chosen around the SLO, not from a default list. The SLO is p99 <
   * 200 ms, so there are buckets either side of 0.2 — without one at exactly
   * 0.2, `histogram_quantile` would interpolate across the boundary the alert
   * is defined on and the alert would fire on an estimate.
   */
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
  registers: [registry],
});

/** Orders placed, by side and outcome. Bounded: 2 × 5. */
export const ordersTotal = new Counter({
  name: 'daftar_orders_total',
  help: 'Orders by side and outcome. Never labelled by account.',
  labelNames: ['side', 'outcome'],
  registers: [registry],
});

/**
 * Order-book orders by side, type and outcome. Bounded: 2 × 2 × 9.
 *
 * Bots and guests are counted together and distinguished by `actor`, a
 * two-value label — never by participant, for the reason nothing here is
 * labelled by account.
 */
export const exchangeOrdersTotal = new Counter({
  name: 'daftar_exchange_orders_total',
  help: 'Order-book orders by actor kind, side, type and outcome.',
  labelNames: ['actor', 'side', 'type', 'outcome'],
  registers: [registry],
});

/** Fills produced by the matching engine, by the aggressor's side. */
export const exchangeTradesTotal = new Counter({
  name: 'daftar_exchange_trades_total',
  help: 'Trades matched, by taker side.',
  labelNames: ['taker_side'],
  registers: [registry],
});

/**
 * Ledger retries by SQLSTATE and concurrency mode.
 *
 * SQLSTATE is the label that makes this worth having: 40001
 * (serialization_failure) and 40P01 (deadlock_detected) mean different things
 * and cost three orders of magnitude apart in latency. A single
 * `retries_total` would average them into uselessness.
 */
export const ledgerRetries = new Counter({
  name: 'daftar_ledger_retries_total',
  help: 'Ledger write retries, by SQLSTATE and concurrency mode.',
  labelNames: ['sqlstate', 'mode'],
  registers: [registry],
});

export const ledgerAttempts = new Histogram({
  name: 'daftar_ledger_attempts',
  help: 'Attempts per successful ledger write, by concurrency mode.',
  labelNames: ['mode'],
  buckets: [1, 2, 3, 5, 8, 13, 21, 50],
  registers: [registry],
});

/** Webhook deliveries by provider and outcome. */
export const webhookDeliveries = new Counter({
  name: 'daftar_webhook_deliveries_total',
  help: 'Inbound webhook deliveries by provider and outcome.',
  labelNames: ['provider', 'outcome'],
  registers: [registry],
});

/**
 * Duplicate rate, as a counter pair rather than a ratio gauge.
 *
 * Prometheus convention: export the numerator and denominator and let the query
 * divide. A pre-computed ratio cannot be re-aggregated across instances or
 * re-windowed, and a gauge of a rate loses the information needed to do either.
 */
export const webhookDuplicates = new Counter({
  name: 'daftar_webhook_duplicates_total',
  help: 'Webhook deliveries that were duplicates of an already-seen event.',
  labelNames: ['provider'],
  registers: [registry],
});

/** Idempotency-key outcomes on the order surface. */
export const idempotencyOutcomes = new Counter({
  name: 'daftar_idempotency_total',
  help: 'Idempotency-Key outcomes: claimed, replay, in_progress, mismatch.',
  labelNames: ['outcome'],
  registers: [registry],
});

/**
 * Connection-pool saturation.
 *
 * `waiting` is the number that matters. `total` and `idle` describe the pool's
 * shape; `waiting > 0` sustained means requests are queueing for a connection,
 * which is a capacity problem that looks like a latency problem.
 */
export const poolGauge = new Gauge({
  name: 'daftar_db_pool',
  help: 'Connection pool: total, idle, waiting.',
  labelNames: ['state'],
  registers: [registry],
});

/**
 * Outbox lag, scraped from the database rather than tracked in process memory.
 *
 * In-process counters would be per-instance and would reset on deploy; the
 * queue depth is a property of the data. `oldest_unpublished_seconds` is the
 * alerting signal — a rising age means the worker is down, slower than the
 * write rate, or stuck on a poison message, and it is visible long before
 * anything else breaks.
 */
export const outboxGauge = new Gauge({
  name: 'daftar_outbox',
  help: 'Outbox depth by state, and the age of the oldest unpublished event.',
  labelNames: ['metric'],
  registers: [registry],
});

/** Serve the registry. */
export const metricsText = (): Promise<string> => registry.metrics();
export const metricsContentType = registry.contentType;

/**
 * Map an HTTP status to a bounded label.
 *
 * `'2xx'` rather than `'200'`: status *classes* keep the label set at five
 * values. The exact code is on the canonical log line, where cardinality costs
 * nothing.
 */
export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;
