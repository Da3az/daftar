import { describe, expect, it } from 'vitest';
import { createIsolatedDatabase, useTestDatabase } from './support/test-database.ts';
import { TEMPLATE_DATABASE } from './support/postgres-url.ts';

/**
 * ## What this file tests, and why it has to exist
 *
 * Every concurrency claim in this repo rests on one property of the test
 * substrate: **two transactions can be in flight at the same time.**
 *
 * PGlite — PostgreSQL compiled to WebAssembly — does not have that property. It
 * runs single-user and holds an exclusive mutex for the duration of each
 * transaction, so transactions are serialised whatever the code does. Under
 * PGlite, a check-then-write race cannot be observed: the buggy code passes.
 *
 * That is not a hypothetical concern for this project; it is *the* bug the
 * project is about. So the substrate's ability to fail is itself tested here. If
 * someone swaps the container for an in-process shim to make CI faster, these
 * tests go red rather than the ledger tests going quietly green.
 */

const ctx = useTestDatabase();

describe('the test database is real PostgreSQL', () => {
  it('is PostgreSQL 18', async () => {
    const { rows } = await ctx.pool.query<{ v: string; num: string }>(
      `SELECT version() AS v, current_setting('server_version_num') AS num`,
    );

    expect(rows[0]?.v).toContain('PostgreSQL 18');
    expect(Number(rows[0]?.num)).toBeGreaterThanOrEqual(180000);
  });

  it('runs READ COMMITTED by default, which is what Phase 1 depends on', async () => {
    // The naive overdraft path's correctness argument — that a self-referential
    // UPDATE is atomic and therefore loses no updates — is specific to this
    // isolation level. If the default changed, that reasoning would not hold.
    const { rows } = await ctx.pool.query<{ level: string }>(
      `SELECT current_setting('default_transaction_isolation') AS level`,
    );

    expect(rows[0]?.level).toBe('read committed');
  });

  it('was cloned from the migrated template, not migrated per file', async () => {
    const { rows } = await ctx.pool.query<{ datname: string }>(
      'SELECT current_database() AS datname',
    );

    expect(rows[0]?.datname).toMatch(/^daftar_test_[0-9a-f]{16}$/);
    expect(rows[0]?.datname).not.toBe(TEMPLATE_DATABASE);
  });

  it('has the schema the template carried', async () => {
    const { rows } = await ctx.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );

    expect(rows.map((r) => r.table_name)).toContain('accounts');
  });
});

describe('two transactions really are concurrent', () => {
  it('a second transaction makes progress while the first is open', async () => {
    /**
     * The direct demonstration. Open a transaction, do work in it, and — without
     * committing — prove a second connection can also open a transaction and do
     * work. Under a single-user engine the second `BEGIN` would block until the
     * first transaction ended, and this test would time out.
     */
    const first = await ctx.pool.connect();
    const second = await ctx.pool.connect();

    try {
      await first.query('BEGIN');
      await first.query(
        `INSERT INTO accounts (external_id, kind) VALUES ('concurrent-first', 'customer_cash')`,
      );

      // First transaction is still open and holding an uncommitted row.
      await second.query('BEGIN');
      const { rows } = await second.query<{ n: bigint }>(
        `SELECT count(*) AS n FROM accounts WHERE external_id LIKE 'concurrent-%'`,
      );

      // READ COMMITTED: the second transaction cannot see the uncommitted row,
      // which is itself proof the two have separate snapshots rather than being
      // the same serialised session.
      expect(rows[0]?.n).toBe(0n);

      await second.query(
        `INSERT INTO accounts (external_id, kind) VALUES ('concurrent-second', 'customer_cash')`,
      );
      await second.query('COMMIT');
      await first.query('COMMIT');

      const { rows: after } = await ctx.pool.query<{ n: bigint }>(
        `SELECT count(*) AS n FROM accounts WHERE external_id LIKE 'concurrent-%'`,
      );
      expect(after[0]?.n).toBe(2n);
    } finally {
      first.release();
      second.release();
    }
  });

  it('a row lock held by one transaction actually blocks another', async () => {
    /**
     * The other half of the property: not only can two transactions coexist,
     * they can genuinely contend. A substrate that serialises everything would
     * never produce a lock wait, and `pg_locks` would never show one granted
     * against another.
     */
    await ctx.pool.query(
      `INSERT INTO accounts (external_id, kind) VALUES ('lock-target', 'customer_cash')`,
    );

    const holder = await ctx.pool.connect();
    const waiter = await ctx.pool.connect();

    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM accounts WHERE external_id = 'lock-target' FOR UPDATE`);

      // Deliberately short, and deliberately per-transaction: the point is to
      // observe the block, not to wait out a default timeout.
      await waiter.query('BEGIN');
      await waiter.query(`SET LOCAL lock_timeout = '250ms'`);

      await expect(
        waiter.query(`SELECT id FROM accounts WHERE external_id = 'lock-target' FOR UPDATE`),
      ).rejects.toMatchObject({
        // 55P03, lock_not_available. Named explicitly: this is NOT 40001
        // (serialization_failure) and NOT 40P01 (deadlock_detected), and
        // conflating the three is the tell Phase 3 is written to avoid.
        code: '55P03',
      });

      await waiter.query('ROLLBACK');
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
      waiter.release();
    }
  });

  it('the pool hands out more than one connection', async () => {
    // A pool of 1 would serialise every test above and they would pass for the
    // same wrong reason PGlite does.
    const clients = await Promise.all([ctx.pool.connect(), ctx.pool.connect(), ctx.pool.connect()]);

    try {
      const pids = await Promise.all(
        clients.map(async (c) => {
          const { rows } = await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          return rows[0]!.pid;
        }),
      );

      // Three distinct server-side backends, which is what "concurrent" means
      // here.
      expect(new Set(pids).size).toBe(3);
    } finally {
      for (const c of clients) c.release();
    }
  });
});

describe('isolation between test databases', () => {
  it('a second database cloned in the same file is independent', async () => {
    const other = await createIsolatedDatabase();

    try {
      await ctx.pool.query(
        `INSERT INTO accounts (external_id, kind) VALUES ('only-in-ctx', 'customer_cash')`,
      );

      const { rows } = await other.pool.query<{ n: bigint }>(
        `SELECT count(*) AS n FROM accounts WHERE external_id = 'only-in-ctx'`,
      );
      expect(rows[0]?.n).toBe(0n);

      // Same schema, different data — which is the template guarantee.
      const { rows: cols } = await other.pool.query<{ n: bigint }>(
        `SELECT count(*) AS n FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'accounts'`,
      );
      expect(cols[0]!.n).toBeGreaterThan(0n);
    } finally {
      await other.drop();
    }
  });
});

describe('database-enforced invariants, not application checks', () => {
  it('PostgreSQL rejects an asset account with no symbol', async () => {
    await expect(
      ctx.pool.query(
        `INSERT INTO accounts (external_id, kind) VALUES ('bad-asset', 'customer_asset')`,
      ),
    ).rejects.toMatchObject({
      // 23514, check_violation — the database refused it, not a TypeScript `if`.
      code: '23514',
      constraint: 'accounts_asset_symbol_matches_kind',
    });
  });

  it('PostgreSQL rejects a cash account carrying a symbol', async () => {
    await expect(
      ctx.pool.query(
        `INSERT INTO accounts (external_id, kind, asset_symbol)
         VALUES ('bad-cash', 'customer_cash', 'BTC')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('PostgreSQL rejects a duplicate external id', async () => {
    await ctx.pool.query(
      `INSERT INTO accounts (external_id, kind) VALUES ('unique-me', 'customer_cash')`,
    );

    await expect(
      ctx.pool.query(`INSERT INTO accounts (external_id, kind) VALUES ('unique-me', 'house_cash')`),
    ).rejects.toMatchObject({
      // 23505, unique_violation.
      code: '23505',
      constraint: 'accounts_external_id_key',
    });
  });

  it('PostgreSQL rejects an unknown account kind', async () => {
    await expect(
      ctx.pool.query(`INSERT INTO accounts (external_id, kind) VALUES ('bad-kind', 'not_a_kind')`),
    ).rejects.toMatchObject({
      // 22P02, invalid_text_representation — the enum did the work.
      code: '22P02',
    });
  });
});
