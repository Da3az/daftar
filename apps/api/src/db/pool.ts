// These two MUST be the first imports in this file. Both register `pg` type
// parsers as an import side effect, and a Pool captures the parsers in force
// when its connections are created. See db/bigint.ts and db/timestamps.ts for
// why each one exists.
import './bigint.ts';
import './timestamps.ts';

import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { env } from '../env.ts';
import * as schema from './schema.ts';

export type Database = NodePgDatabase<typeof schema> & { $client: pg.Pool };

export interface PoolOptions {
  connectionString: string;
  max?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
}

/**
 * Build a pool. Not a module-level singleton: tests create one per template
 * database, the outbox worker gets its own with a separate `max` so its pool
 * arithmetic can be reasoned about independently, and the chaos burst endpoint
 * needs to be able to saturate a pool without taking the API's own pool down.
 */
export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? env.DB_POOL_MAX,
    connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT_MS,

    /**
     * Applied by the driver as a connection parameter, so it is in force for
     * every statement on every connection without a per-transaction `SET`.
     *
     * A ledger write slower than this is holding row locks that other writers
     * are queued behind, so failing it is the lesser harm. Phase 3's retry loop
     * distinguishes this (57014, query_canceled) from a serialization failure.
     */
    statement_timeout: options.statementTimeoutMs ?? env.DB_STATEMENT_TIMEOUT_MS,

    /**
     * Shows up in `pg_stat_activity.application_name`, which is how you find out
     * which component is holding the connections when the pool is exhausted.
     */
    application_name: options.applicationName ?? 'daftar-api',
  });

  /**
   * A pool emits 'error' for a client that fails while **idle** — a server
   * restart, an admin `pg_terminate_backend`, a network drop. Without a listener
   * this is an unhandled 'error' event and Node takes the process down.
   *
   * Deliberately not logged through pino here: `createPool` has no request
   * context, and a logger import would make this module unusable from scripts.
   * The caller attaches real logging; this listener exists so the default is
   * "stay up", not "crash".
   */
  pool.on('error', () => {
    /* idle client error — the pool discards the client and carries on */
  });

  return pool;
}

export function createDatabase(pool: pg.Pool): Database {
  return drizzle(pool, { schema, casing: 'snake_case' });
}
