import { buildApp } from './app.ts';
import { createPool } from './db/pool.ts';
import { env } from './env.ts';
import { logger } from './logging.ts';

const pool = createPool({ connectionString: env.DATABASE_URL, applicationName: 'daftar-api' });
const app = await buildApp({ pool });

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
    await pool.end();
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
