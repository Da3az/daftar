/**
 * Where the tests' PostgreSQL lives, and how to point at a different database on
 * the same server.
 *
 * Kept free of imports from `src/` so it can be used by `globalSetup`, which
 * runs before Vitest has set up the test environment and must not pull in
 * `src/env.ts` (that would exit the process if the test env were incomplete).
 */

export const DEFAULT_TEST_POSTGRES_URL = 'postgres://daftar:daftar@127.0.0.1:55432/daftar';

export function basePostgresUrl(source: NodeJS.ProcessEnv = process.env): string {
  return source['TEST_DATABASE_URL'] ?? source['DATABASE_URL'] ?? DEFAULT_TEST_POSTGRES_URL;
}

/** Same server, different database name. */
export function withDatabaseName(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

/**
 * `CREATE DATABASE` and `DROP DATABASE` cannot run against the database they
 * operate on, so administrative statements go to `postgres`, the maintenance
 * database every cluster has.
 */
export function maintenanceUrl(url: string): string {
  return withDatabaseName(url, 'postgres');
}

/**
 * The template every test database is cloned from. One per migration state would
 * be nice, but migrations are applied fresh on each `globalSetup`, so one fixed
 * name is enough and makes a stale template easy to spot in `\l`.
 */
export const TEMPLATE_DATABASE = 'daftar_test_template';

/** Prefix for cloned databases, so a crashed run's leftovers are identifiable. */
export const CLONE_PREFIX = 'daftar_test_';

/**
 * PostgreSQL identifiers are limited to 63 bytes (NAMEDATALEN - 1) and are
 * folded to lower case unless quoted. Database names are built from this, never
 * from user input, but the assertion is cheap and a truncated name would collide
 * silently.
 */
export function assertValidDatabaseName(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`unusable PostgreSQL database name: ${name}`);
  }
}
