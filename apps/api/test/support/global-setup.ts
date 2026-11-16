import { Client, type QueryResultRow } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  CLONE_PREFIX,
  TEMPLATE_DATABASE,
  assertValidDatabaseName,
  basePostgresUrl,
  maintenanceUrl,
  withDatabaseName,
} from './postgres-url.ts';

/**
 * ## Why a real PostgreSQL container and not PGlite
 *
 * PGlite compiles PostgreSQL to WebAssembly and runs it **single-user**, holding
 * an exclusive mutex for the duration of each transaction. Two transactions are
 * therefore never in flight simultaneously — which means check-then-write code
 * that would lose an update against a real server *passes* against PGlite.
 *
 * That is precisely the class of bug this repo exists to demonstrate, so the
 * test substrate has to be capable of failing. Every concurrency test here would
 * be worthless under PGlite, and worse than worthless: it would be green.
 *
 * ## Why a template database
 *
 * Applying migrations per test file costs the full DDL every time and grows with
 * the migration count. `CREATE DATABASE … TEMPLATE …` is a filesystem-level copy
 * of an already-migrated database, so it stays roughly constant and each test
 * file still gets a completely isolated database — no shared schema, no
 * truncate-between-tests ordering hazards, and real concurrency inside a file.
 *
 * Two constraints that shape the code below:
 *
 *  - `CREATE DATABASE` cannot run inside a transaction block.
 *  - A database cannot be used as a template while anything else is connected to
 *    it, so this setup closes its own connection before any test file runs.
 */

const base = basePostgresUrl();
const admin = maintenanceUrl(base);

async function adminQuery(sql: string, values: unknown[] = []): Promise<void> {
  const client = new Client({ connectionString: admin, application_name: 'daftar-test-setup' });
  await client.connect();
  try {
    await client.query(sql, values);
  } finally {
    await client.end();
  }
}

async function adminRows<T extends QueryResultRow>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new Client({ connectionString: admin, application_name: 'daftar-test-setup' });
  await client.connect();
  try {
    const result = await client.query<T>(sql, values);
    return result.rows;
  } finally {
    await client.end();
  }
}

/**
 * Drop leftover clones from a previous run that was killed before teardown.
 *
 * Deliberately narrow: only databases whose name starts with the clone prefix.
 * A test harness that can drop an arbitrary database is a loaded gun pointed at
 * whatever `DATABASE_URL` happens to be set to.
 */
async function dropStaleClones(): Promise<number> {
  const rows = await adminRows<{ datname: string }>(
    `SELECT datname FROM pg_database
      WHERE datname LIKE $1 || '%' AND datname <> $2`,
    [CLONE_PREFIX, TEMPLATE_DATABASE],
  );

  for (const { datname } of rows) {
    assertValidDatabaseName(datname);
    await adminQuery(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
  }

  return rows.length;
}

export async function setup(): Promise<void> {
  const stale = await dropStaleClones();
  if (stale > 0) {
    process.stdout.write(`[test-db] dropped ${String(stale)} stale test database(s)\n`);
  }

  /**
   * `WITH (FORCE)` terminates other sessions on the target first. Without it,
   * a leftover connection — a watch-mode worker, an open psql, a pgAdmin tab —
   * makes the drop fail with 55006 (object_in_use) and the whole suite cannot
   * start. Available since PostgreSQL 13.
   */
  await adminQuery(`DROP DATABASE IF EXISTS "${TEMPLATE_DATABASE}" WITH (FORCE)`);

  /**
   * `IS_TEMPLATE = false`: a database flagged as a template cannot be dropped
   * until the flag is cleared, which turns a routine re-run into a manual
   * recovery. `CREATE DATABASE … TEMPLATE x` works on any database, flag or not;
   * the flag only controls who may copy it.
   */
  await adminQuery(`CREATE DATABASE "${TEMPLATE_DATABASE}" WITH IS_TEMPLATE = false`);

  const templateUrl = withDatabaseName(base, TEMPLATE_DATABASE);
  const client = new Client({
    connectionString: templateUrl,
    application_name: 'daftar-test-migrate',
  });
  await client.connect();

  try {
    await migrate(drizzle(client), {
      migrationsFolder: new URL('../../drizzle', import.meta.url).pathname,
    });
  } finally {
    // Must close before any test file clones this database: PostgreSQL refuses
    // to use a database as a template while another session is connected.
    await client.end();
  }

  process.stdout.write(`[test-db] template ${TEMPLATE_DATABASE} ready\n`);
}

export async function teardown(): Promise<void> {
  await dropStaleClones();
  await adminQuery(`DROP DATABASE IF EXISTS "${TEMPLATE_DATABASE}" WITH (FORCE)`);
}
