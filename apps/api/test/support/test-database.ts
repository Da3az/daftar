import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import {
  CLONE_PREFIX,
  TEMPLATE_DATABASE,
  assertValidDatabaseName,
  basePostgresUrl,
  maintenanceUrl,
  withDatabaseName,
} from './postgres-url.ts';
import { createDatabase, createPool, type Database } from '../../src/db/pool.ts';

export interface TestDatabase {
  /** Connection URL of this file's private database. */
  readonly url: string;
  readonly name: string;
  readonly pool: pg.Pool;
  readonly db: Database;
}

const base = basePostgresUrl();
const admin = maintenanceUrl(base);

async function adminQuery(sql: string): Promise<void> {
  const client = new Client({ connectionString: admin, application_name: 'daftar-test-admin' });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * Create a fresh database for the caller by cloning the migrated template.
 *
 * The name carries 8 random bytes rather than a counter: Vitest runs test files
 * in parallel workers, each a separate process with its own module state, so a
 * counter would collide across workers.
 */
export async function createIsolatedDatabase(
  options: { poolMax?: number } = {},
): Promise<TestDatabase & { drop: () => Promise<void> }> {
  const name = `${CLONE_PREFIX}${randomBytes(8).toString('hex')}`;
  assertValidDatabaseName(name);

  await adminQuery(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DATABASE}"`);

  const url = withDatabaseName(base, name);
  const pool = createPool({
    connectionString: url,
    /**
     * Default 10, not 1. Several tests in this repo exist specifically to run
     * two or more transactions simultaneously; a pool of 1 would serialise them
     * and the test would pass for the same wrong reason PGlite does.
     */
    max: options.poolMax ?? 10,
    // Index builds and deliberate lock-wait tests legitimately exceed the
    // request-path timeout.
    statementTimeoutMs: 0,
    applicationName: `daftar-test-${name}`,
  });

  const drop = async (): Promise<void> => {
    await pool.end();
    await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  };

  return { url, name, pool, db: createDatabase(pool), drop };
}

/**
 * Per-file harness. Call at the top level of a test file:
 *
 * ```ts
 * const ctx = useTestDatabase();
 * it('...', async () => { await ctx.pool.query('...'); });
 * ```
 *
 * Returns a stable object whose fields are filled in `beforeAll`, so test bodies
 * can close over it at module scope. Destructuring it at module scope would
 * capture undefined — hence the getters, which throw a useful message instead of
 * a `Cannot read properties of undefined`.
 */
export function useTestDatabase(options: { poolMax?: number } = {}): TestDatabase {
  let active: (TestDatabase & { drop: () => Promise<void> }) | undefined;

  const require_ = <K extends keyof TestDatabase>(key: K): TestDatabase[K] => {
    if (!active) {
      throw new Error(
        'test database not ready — useTestDatabase() fields are only valid inside a test or hook',
      );
    }
    return active[key];
  };

  beforeAll(async () => {
    active = await createIsolatedDatabase(options);
  }, 60_000);

  afterAll(async () => {
    await active?.drop();
    active = undefined;
  }, 60_000);

  return {
    get url() {
      return require_('url');
    },
    get name() {
      return require_('name');
    },
    get pool() {
      return require_('pool');
    },
    get db() {
      return require_('db');
    },
  };
}
