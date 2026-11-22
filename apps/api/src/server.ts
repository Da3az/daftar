import { env } from './env.ts';
import { logger } from './logging.ts';
import { startTracing, stopTracing } from './observability/tracing.ts';

/**
 * ## Why the application is imported *dynamically*, below
 *
 * OpenTelemetry's ESM instrumentation patches modules **as they are loaded**.
 * Static `import` declarations are hoisted and evaluated before any statement in
 * this file runs — so a static `import { buildApp } from './app.ts'` would load
 * `fastify` and `pg` before `startTracing()` had a chance to register the loader
 * hook, and the instrumentations would then patch module objects nobody holds a
 * reference to. The result is not an error: it is empty traces, which is a much
 * worse failure because it looks like "nothing happened".
 *
 * So the three static imports above are deliberately restricted to modules with
 * nothing to instrument — `env.ts` pulls in zod, `logging.ts` pulls in pino,
 * `tracing.ts` pulls in the SDK — and everything that touches HTTP or the
 * database is loaded after.
 *
 * The usual alternative is `node --import ./instrumentation.js`, which keeps the
 * imports static. That was not chosen because it moves a required startup step
 * out of the code and into whatever launches the process, where a Dockerfile, a
 * compose file and an npm script can each forget it independently.
 */
if (env.OTEL_ENABLED) {
  startTracing({
    environment: env.NODE_ENV,
    endpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    sampleRatio: env.OTEL_SAMPLE_RATIO,
  });
  logger.info(
    { endpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, sample_ratio: env.OTEL_SAMPLE_RATIO },
    'tracing started',
  );
}

const { buildApp } = await import('./app.ts');
const { createPool } = await import('./db/pool.ts');

const pool = createPool({ connectionString: env.DATABASE_URL, applicationName: 'daftar-api' });
const app = await buildApp({ pool });

/**
 * The bots, when this deployment has asked for them. Started after the app is
 * built so they log through the same logger, and before `listen` only in the
 * sense that neither waits for the other — the runner campaigns for its leader
 * lock in the background and never blocks boot.
 */
const bots = env.EXCHANGE_BOTS_ENABLED
  ? (await import('./exchange/bots.ts')).startBots(pool, {
      symbol: (await import('./exchange/engine.ts')).DEFAULT_MARKET,
      count: env.EXCHANGE_BOT_COUNT,
      meanIntervalMs: env.EXCHANGE_BOT_MEAN_INTERVAL_MS,
      log: app.log,
    })
  : null;

/**
 * The outbox worker, on the same opt-in terms as the bots. With it off, events
 * still commit with the money that caused them; they wait.
 */
/*
 * Only in `direct` mode. As a relay to the event log the worker belongs to
 * the worker process (`workers.ts`), which owns the producer; running it here
 * too would split each account's events between two claimers.
 */
if (env.OUTBOX_WORKER_ENABLED && env.OUTBOX_PUBLISHER === 'kafka') {
  app.log.warn('OUTBOX_PUBLISHER=kafka: the relay runs in the worker process, not the API');
}
const outbox =
  env.OUTBOX_WORKER_ENABLED && env.OUTBOX_PUBLISHER === 'direct'
    ? (await import('./outbox/runner.ts')).startOutboxWorker(pool, {
        pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
        log: app.log,
      })
    : null;

/**
 * Graceful shutdown, in the order that matters: stop accepting connections and
 * drain in-flight requests first, *then* close the pool. Closing the pool first
 * would fail every request that is mid-transaction, which during a rolling
 * deploy means a burst of 500s that look like an application bug.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'shutting down');

  try {
    await app.close();
    // Before the pool: an in-flight bot order is a transaction on it.
    await bots?.stop();
    // Likewise: a cycle in progress holds claimed rows it should get to settle.
    await outbox?.stop();
    await pool.end();
    // Last, and after the pool: flushing spans needs the export to finish, and
    // the final spans are the ones describing the requests that were still
    // draining. Shutting the SDK down first would discard exactly those.
    await stopTracing();
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

/**
 * An unhandled rejection leaves the process in an unknown state. Logging and
 * continuing is worse than exiting: a supervisor restarts a dead process, but
 * nothing rescues one that is quietly half-broken and still serving.
 */
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  logger.fatal({ err }, 'failed to listen');
  process.exit(1);
}
