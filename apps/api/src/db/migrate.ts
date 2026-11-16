import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase, createPool } from './pool.ts';
import { env } from '../env.ts';
import { logger } from '../logging.ts';

/**
 * Migrations are run as an explicit, separate step — never on application boot.
 *
 * A boot-time migration turns a rolling deploy into a schema race between
 * instances: two containers start, both see pending migrations, both try to
 * apply them. Drizzle takes an advisory lock, so the loser waits rather than
 * corrupting anything, but it then serves traffic against a schema it did not
 * verify, and the deploy's success no longer tells you the migration succeeded.
 *
 * `migrationsFolder` includes the hand-written custom migrations
 * (`drizzle-kit generate --custom`) that carry the triggers drizzle-kit cannot
 * emit. They are ordinary journal entries, applied in the same order.
 */
const pool = createPool({
  connectionString: env.DATABASE_URL,
  max: 1,
  // Index builds and table rewrites legitimately take longer than a request.
  statementTimeoutMs: 0,
  applicationName: 'daftar-migrate',
});

try {
  const db = createDatabase(pool);
  await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
  logger.info('migrations applied');
} catch (err) {
  logger.fatal({ err, sqlstate: (err as { code?: string }).code ?? null }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
