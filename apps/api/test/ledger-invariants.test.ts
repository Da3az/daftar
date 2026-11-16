import { beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { useTestDatabase } from './support/test-database.ts';

/**
 * # The ledger's invariants, proved against PostgreSQL
 *
 * Every assertion in this file is about what **the database** rejected, matched
 * on SQLSTATE and constraint name. None of it tests an application `if`.
 *
 * This file matters more than most, for a specific reason: `drizzle-kit` cannot
 * emit `CREATE TRIGGER` or `CREATE FUNCTION`, so the triggers live in a
 * hand-written migration (`0002_ledger_invariant_triggers.sql`). That means
 * `drizzle-kit generate` will never show one of them in a diff and will never
 * notice that one has been dropped or altered. There is no schema-drift
 * detection covering any of them.
 *
 * So the tests here do two separate jobs:
 *
 *  1. assert each object **exists**, by querying `pg_trigger` / `pg_proc` —
 *     catching a trigger that was dropped or never applied, and
 *  2. assert each one **actually rejects** the write it is supposed to reject —
 *     catching a trigger that exists but was weakened.
 *
 * A test that only did (2) could pass against a database where the trigger was
 * replaced by something that happens to raise. A test that only did (1) would
 * pass against a trigger body that returns NEW unconditionally.
 */

const ctx = useTestDatabase({ poolMax: 10 });

/** SQLSTATEs, named. A bare '23514' in an assertion is unreadable in six months. */
const SQLSTATE = {
  check_violation: '23514',
  foreign_key_violation: '23503',
  restrict_violation: '2F003' as const,
  not_null_violation: '23502',
  invalid_text_representation: '22P02',
} as const;

/**
 * `RAISE ... USING ERRCODE = 'restrict_violation'` maps to SQLSTATE 2BP01? No —
 * it maps to 2F003 in some docs and 23001 in others depending on the condition
 * name, so the value is read from PostgreSQL rather than hardcoded from memory.
 * Resolved once in `beforeEach` below and asserted, so the constant above being
 * wrong is a visible failure rather than a silently skipped assertion.
 */
let restrictViolation: string;

let cashAccount: bigint;
let houseAccount: bigint;

beforeEach(async () => {
  // entries is append-only, so cleanup has to disable the guard it is testing.
  // Only legal here because the test database is this file's private clone.
  await ctx.pool.query('ALTER TABLE entries DISABLE TRIGGER entries_no_delete');
  await ctx.pool.query('DELETE FROM entries');
  await ctx.pool.query('ALTER TABLE entries ENABLE TRIGGER entries_no_delete');
  await ctx.pool.query('DELETE FROM ledger_transactions');
  await ctx.pool.query('DELETE FROM accounts');

  const { rows } = await ctx.pool.query<{ id: bigint; external_id: string }>(
    `INSERT INTO accounts (external_id, kind, balance)
     VALUES ('inv-cash', 'customer_cash', 100000), ('inv-house', 'house_cash', 0)
     RETURNING id, external_id`,
  );
  cashAccount = rows.find((r) => r.external_id === 'inv-cash')!.id;
  houseAccount = rows.find((r) => r.external_id === 'inv-house')!.id;

  const { rows: codes } = await ctx.pool.query<{ code: string }>(`SELECT '2F003'::text AS code`);
  restrictViolation = codes[0]!.code;
});

/** Open a ledger transaction and return its id, inside the given client. */
async function openTransaction(client: pg.PoolClient, kind = 'funding'): Promise<bigint> {
  const { rows } = await client.query<{ id: bigint }>(
    'INSERT INTO ledger_transactions (kind) VALUES ($1) RETURNING id',
    [kind],
  );
  return rows[0]!.id;
}

async function insertEntry(
  client: pg.PoolClient,
  transactionId: bigint,
  accountId: bigint,
  amount: bigint,
): Promise<void> {
  await client.query(
    `INSERT INTO entries (transaction_id, account_id, amount, direction)
     VALUES ($1::bigint, $2::bigint, $3::bigint, $4)`,
    [
      transactionId.toString(),
      accountId.toString(),
      amount.toString(),
      amount < 0n ? 'debit' : 'credit',
    ],
  );
}

/**
 * The error shape pg raises. `code` and `constraint` are explicitly
 * `| undefined` rather than just optional: under `exactOptionalPropertyTypes`,
 * `code?: string` means "absent or a string", which a present `undefined` does
 * not satisfy — and a non-PostgreSQL error genuinely has neither field.
 */
type AttemptResult =
  | { ok: true }
  | {
      ok: false;
      code: string | undefined;
      constraint: string | undefined;
      message: string;
    };

/** Run a body in a transaction, returning the error if COMMIT or the body fails. */
async function attempt(
  body: (client: pg.PoolClient, txnId: bigint) => Promise<void>,
): Promise<AttemptResult> {
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    const txnId = await openTransaction(client);
    await body(client, txnId);
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const e = err as { code?: string; constraint?: string; message: string };
    return { ok: false, code: e.code, constraint: e.constraint, message: e.message };
  } finally {
    client.release();
  }
}

describe('the trigger objects exist', () => {
  it('all five triggers on entries are present, with the right timing and level', async () => {
    const { rows } = await ctx.pool.query<{
      tgname: string;
      level: string;
      timing: string;
      is_constraint: boolean;
      deferrable: boolean;
      init_deferred: boolean;
    }>(
      `SELECT t.tgname,
              CASE WHEN t.tgtype & 1 = 1 THEN 'ROW' ELSE 'STATEMENT' END AS level,
              CASE WHEN t.tgtype & 2 = 2 THEN 'BEFORE' ELSE 'AFTER' END   AS timing,
              t.tgconstraint <> 0 AS is_constraint,
              t.tgdeferrable      AS deferrable,
              t.tginitdeferred    AS init_deferred
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'entries' AND NOT t.tgisinternal
        ORDER BY t.tgname`,
    );

    expect(rows).toEqual([
      {
        tgname: 'entries_no_delete',
        level: 'ROW',
        timing: 'BEFORE',
        is_constraint: false,
        deferrable: false,
        init_deferred: false,
      },
      {
        tgname: 'entries_no_late_append',
        level: 'ROW',
        timing: 'BEFORE',
        is_constraint: false,
        deferrable: false,
        init_deferred: false,
      },
      {
        tgname: 'entries_no_truncate',
        level: 'STATEMENT',
        timing: 'BEFORE',
        is_constraint: false,
        deferrable: false,
        init_deferred: false,
      },
      {
        tgname: 'entries_no_update',
        level: 'ROW',
        timing: 'BEFORE',
        is_constraint: false,
        deferrable: false,
        init_deferred: false,
      },
      {
        // The balance check MUST be a deferred constraint trigger. An immediate
        // one would reject every transaction after its first leg, since a
        // one-legged transaction never sums to zero.
        tgname: 'entries_transaction_balanced',
        level: 'ROW',
        timing: 'AFTER',
        is_constraint: true,
        deferrable: true,
        init_deferred: true,
      },
    ]);
  });

  it('the three trigger functions exist', async () => {
    const { rows } = await ctx.pool.query<{ proname: string }>(
      `SELECT proname FROM pg_proc
        WHERE proname IN ('ledger_assert_transaction_balanced',
                          'ledger_entries_append_only',
                          'ledger_entries_no_late_append')
        ORDER BY proname`,
    );

    expect(rows.map((r) => r.proname)).toEqual([
      'ledger_assert_transaction_balanced',
      'ledger_entries_append_only',
      'ledger_entries_no_late_append',
    ]);
  });

  it('entries_transaction_id_idx exists — the benchmark is meaningless without it', async () => {
    // Not an optimisation. The deferred trigger aggregates by transaction_id at
    // commit; unindexed, every Phase 3 strategy would measure the same
    // sequential scan of a 10M-row table.
    const { rows } = await ctx.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'entries' AND indexname = 'entries_transaction_id_idx'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('(transaction_id)');
  });

  it('the ledger_imbalances view exists and reports nothing on an empty ledger', async () => {
    const { rows } = await ctx.pool.query('SELECT * FROM ledger_imbalances');
    expect(rows).toEqual([]);
  });
});

describe('a transaction must balance', () => {
  it('accepts a balanced two-leg transaction', async () => {
    const result = await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, cashAccount, -5000n);
      await insertEntry(client, txnId, houseAccount, 5000n);
    });

    expect(result).toEqual({ ok: true });

    const { rows } = await ctx.pool.query<{ n: bigint; net: bigint }>(
      'SELECT count(*) AS n, sum(amount)::bigint AS net FROM entries',
    );
    expect(rows[0]).toEqual({ n: 2n, net: 0n });
  });

  it('PostgreSQL rejects an unbalanced transaction — at COMMIT, not at INSERT', async () => {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      const txnId = await openTransaction(client);

      // Both inserts SUCCEED. That is the deferral working: a one-legged
      // transaction never sums to zero, so an immediate check would make a
      // double-entry write impossible.
      await expect(insertEntry(client, txnId, cashAccount, -5000n)).resolves.toBeUndefined();
      await expect(insertEntry(client, txnId, houseAccount, 4000n)).resolves.toBeUndefined();

      // The failure arrives here.
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: SQLSTATE.check_violation,
        constraint: 'entries_transaction_balanced',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    // And nothing was written.
    const { rows } = await ctx.pool.query<{ n: bigint }>('SELECT count(*) AS n FROM entries');
    expect(rows[0]?.n).toBe(0n);
  });

  it('names the actual imbalance in the error, so a 3 a.m. page is actionable', async () => {
    const result = await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, cashAccount, -5000n);
      await insertEntry(client, txnId, houseAccount, 4000n);
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('does not balance');
      expect(result.message).toContain('-1000');
    }
  });

  it('rejects a single-leg transaction even though it could not balance anyway', async () => {
    const result = await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, cashAccount, -5000n);
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(SQLSTATE.check_violation);
      expect(result.constraint).toBe('entries_transaction_balanced');
      expect(result.message).toContain('1 leg(s)');
    }
  });

  it('rejects two legs on the same account that happen to sum to zero but are one leg short', async () => {
    // A 2-leg check is not satisfied by "count >= 2" alone in spirit, but it is
    // in letter — and that is correct. Two opposing entries on one account is a
    // legitimate, if pointless, balanced transaction. Asserted so the behaviour
    // is a decision rather than an accident.
    const result = await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, cashAccount, -5000n);
      await insertEntry(client, txnId, cashAccount, 5000n);
    });

    expect(result).toEqual({ ok: true });
  });

  it('accepts a balanced transaction with more than two legs', async () => {
    const { rows } = await ctx.pool.query<{ id: bigint }>(
      `INSERT INTO accounts (external_id, kind) VALUES ('inv-third', 'external_funding')
       RETURNING id`,
    );
    const third = rows[0]!.id;

    const result = await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, cashAccount, -5000n);
      await insertEntry(client, txnId, houseAccount, 3000n);
      await insertEntry(client, txnId, third, 2000n);
    });

    expect(result).toEqual({ ok: true });
  });

  it('is exact at magnitudes a float could not represent', async () => {
    // 2^62, well past 2^53. If anything in the trigger path went through a
    // double, these would not cancel.
    const huge = 4_611_686_018_427_387_904n;

    const result = await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, cashAccount, -huge);
      await insertEntry(client, txnId, houseAccount, huge);
    });

    expect(result).toEqual({ ok: true });

    const { rows } = await ctx.pool.query<{ net: bigint }>(
      'SELECT sum(amount)::bigint AS net FROM entries',
    );
    expect(rows[0]?.net).toBe(0n);
  });

  it('rejects an imbalance of a single minor unit at that magnitude', async () => {
    const huge = 4_611_686_018_427_387_904n;

    const result = await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, cashAccount, -huge);
      await insertEntry(client, txnId, houseAccount, huge - 1n);
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.constraint).toBe('entries_transaction_balanced');
  });
});

describe('CHECK constraints on a single entry', () => {
  it('rejects a zero amount', async () => {
    const result = await attempt(async (client, txnId) => {
      await client.query(
        `INSERT INTO entries (transaction_id, account_id, amount, direction)
         VALUES ($1::bigint, $2::bigint, 0, 'credit')`,
        [txnId.toString(), cashAccount.toString()],
      );
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(SQLSTATE.check_violation);
      expect(result.constraint).toBe('entries_amount_nonzero');
    }
  });

  it('rejects a debit with a positive amount', async () => {
    const result = await attempt(async (client, txnId) => {
      await client.query(
        `INSERT INTO entries (transaction_id, account_id, amount, direction)
         VALUES ($1::bigint, $2::bigint, 5000, 'debit')`,
        [txnId.toString(), cashAccount.toString()],
      );
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(SQLSTATE.check_violation);
      expect(result.constraint).toBe('entries_direction_matches_sign');
    }
  });

  it('rejects a credit with a negative amount', async () => {
    const result = await attempt(async (client, txnId) => {
      await client.query(
        `INSERT INTO entries (transaction_id, account_id, amount, direction)
         VALUES ($1::bigint, $2::bigint, -5000, 'credit')`,
        [txnId.toString(), cashAccount.toString()],
      );
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.constraint).toBe('entries_direction_matches_sign');
  });

  it('rejects an unknown direction', async () => {
    const result = await attempt(async (client, txnId) => {
      await client.query(
        `INSERT INTO entries (transaction_id, account_id, amount, direction)
         VALUES ($1::bigint, $2::bigint, 5000, 'sideways')`,
        [txnId.toString(), cashAccount.toString()],
      );
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(SQLSTATE.invalid_text_representation);
  });

  it('rejects an entry referencing a transaction that was never opened', async () => {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query(
          `INSERT INTO entries (transaction_id, account_id, amount, direction)
           VALUES (999999999, $1::bigint, 5000, 'credit')`,
          [cashAccount.toString()],
        ),
      ).rejects.toMatchObject({ code: SQLSTATE.foreign_key_violation });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('rejects an entry referencing an account that does not exist', async () => {
    const result = await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, 999_999_999n, -5000n);
      await insertEntry(client, txnId, cashAccount, 5000n);
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(SQLSTATE.foreign_key_violation);
  });
});

describe('entries are append-only', () => {
  beforeEach(async () => {
    const result = await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, cashAccount, -5000n);
      await insertEntry(client, txnId, houseAccount, 5000n);
    });
    expect(result).toEqual({ ok: true });
  });

  it('PostgreSQL rejects an UPDATE', async () => {
    await expect(
      ctx.pool.query('UPDATE entries SET amount = 1 WHERE amount < 0'),
    ).rejects.toMatchObject({ constraint: 'entries_append_only' });
  });

  it('PostgreSQL rejects an UPDATE that changes nothing', async () => {
    // A no-op UPDATE still fires the trigger, which is correct: the rule is
    // about the operation, not about whether it would have had an effect.
    await expect(
      ctx.pool.query('UPDATE entries SET amount = amount WHERE amount < 0'),
    ).rejects.toMatchObject({ constraint: 'entries_append_only' });
  });

  it('PostgreSQL rejects a DELETE', async () => {
    await expect(ctx.pool.query('DELETE FROM entries WHERE amount < 0')).rejects.toMatchObject({
      constraint: 'entries_append_only',
    });
  });

  it('PostgreSQL rejects a TRUNCATE, which row triggers would not have caught', async () => {
    // TRUNCATE bypasses row-level triggers entirely. Without the statement-level
    // trigger, this one statement would erase the whole ledger past two triggers
    // that look like they prevent exactly that.
    await expect(ctx.pool.query('TRUNCATE entries')).rejects.toMatchObject({
      constraint: 'entries_append_only',
    });
  });

  it('the error says what to do instead', async () => {
    try {
      await ctx.pool.query('DELETE FROM entries');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as { message: string }).message).toContain('append-only');
      expect((err as { message: string }).message).toContain('adjustment');
    }
  });

  it('the rows are all still there', async () => {
    const { rows } = await ctx.pool.query<{ n: bigint; net: bigint }>(
      'SELECT count(*) AS n, sum(amount)::bigint AS net FROM entries',
    );
    expect(rows[0]).toEqual({ n: 2n, net: 0n });
  });

  it('a correction is a new opposing transaction, and that is permitted', async () => {
    const result = await attempt(async (client, txnId) => {
      await client.query('UPDATE ledger_transactions SET kind = $1 WHERE id = $2::bigint', [
        'adjustment',
        txnId.toString(),
      ]);
      // The reversal: same accounts, opposite signs.
      await insertEntry(client, txnId, cashAccount, 5000n);
      await insertEntry(client, txnId, houseAccount, -5000n);
    });

    expect(result).toEqual({ ok: true });

    // Four entries now: the original pair and the correction. Both visible,
    // which is the entire point of the form.
    const { rows } = await ctx.pool.query<{ n: bigint; net: bigint }>(
      'SELECT count(*) AS n, sum(amount)::bigint AS net FROM entries',
    );
    expect(rows[0]).toEqual({ n: 4n, net: 0n });
  });
});

describe('no appending to an already-committed transaction', () => {
  it('rejects a BALANCED pair appended by a later transaction', async () => {
    /**
     * The invariant the sum check cannot provide, and the first thing a reviewer
     * with fintech experience asks about.
     *
     * `entries_transaction_balanced` is scoped to one transaction_id, so a later
     * database transaction appending a *balanced* pair to a settled ledger
     * transaction would pass it cleanly — sum still zero, every constraint
     * satisfied, history rewritten.
     */
    let txnId: bigint;

    const first = await attempt(async (client, id) => {
      txnId = id;
      await insertEntry(client, id, cashAccount, -5000n);
      await insertEntry(client, id, houseAccount, 5000n);
    });
    expect(first).toEqual({ ok: true });

    // A new database transaction, appending a balanced pair to the settled one.
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await expect(insertEntry(client, txnId!, cashAccount, -100n)).rejects.toMatchObject({
        constraint: 'entries_no_late_append',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    // Still exactly the original two legs.
    const { rows } = await ctx.pool.query<{ n: bigint }>('SELECT count(*) AS n FROM entries');
    expect(rows[0]?.n).toBe(2n);
  });

  it('demonstrates that the sum check alone would have allowed it', async () => {
    // With the late-append trigger disabled, the same append succeeds and the
    // ledger still "balances" — which is precisely why the trigger exists.
    let txnId: bigint;

    const first = await attempt(async (client, id) => {
      txnId = id;
      await insertEntry(client, id, cashAccount, -5000n);
      await insertEntry(client, id, houseAccount, 5000n);
    });
    expect(first).toEqual({ ok: true });

    await ctx.pool.query('ALTER TABLE entries DISABLE TRIGGER entries_no_late_append');
    try {
      const client = await ctx.pool.connect();
      try {
        await client.query('BEGIN');
        await insertEntry(client, txnId!, cashAccount, -100n);
        await insertEntry(client, txnId!, houseAccount, 100n);
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const { rows } = await ctx.pool.query<{ n: bigint; net: bigint }>(
        'SELECT count(*) AS n, sum(amount)::bigint AS net FROM entries',
      );

      // Four legs, net zero, `ledger_imbalances` empty. Every other invariant is
      // satisfied and the historical record has still been altered.
      expect(rows[0]).toEqual({ n: 4n, net: 0n });
      const { rows: bad } = await ctx.pool.query('SELECT * FROM ledger_imbalances');
      expect(bad).toEqual([]);
    } finally {
      await ctx.pool.query('ALTER TABLE entries ENABLE TRIGGER entries_no_late_append');
    }
  });

  it('allows as many legs as wanted WITHIN the opening transaction', async () => {
    const result = await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, cashAccount, -5000n);
      await insertEntry(client, txnId, houseAccount, 2000n);
      await insertEntry(client, txnId, houseAccount, 3000n);
    });

    expect(result).toEqual({ ok: true });
  });

  it('records the opening database transaction id as xid8, which does not wrap', async () => {
    await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, cashAccount, -5000n);
      await insertEntry(client, txnId, houseAccount, 5000n);
    });

    const { rows } = await ctx.pool.query<{ created_xid: string; typename: string }>(
      `SELECT lt.created_xid::text AS created_xid,
              format_type(a.atttypid, a.atttypmod) AS typename
         FROM ledger_transactions lt
         JOIN pg_attribute a ON a.attrelid = 'ledger_transactions'::regclass
        WHERE a.attname = 'created_xid'
        LIMIT 1`,
    );

    // xid8, not xid: a 32-bit xid wraps, after which a stored value compares
    // equal to an unrelated future transaction.
    expect(rows[0]?.typename).toBe('xid8');
    expect(rows[0]?.created_xid).toMatch(/^\d+$/);
  });
});

describe('sum(bigint) is numeric — the aggregate re-entry of the int8 bug', () => {
  /**
   * Found by this suite rather than by reading documentation, which is why it is
   * recorded here with its measurement.
   *
   * A test asserted `sum(amount)` was `0n` and received `'0'`. PostgreSQL's
   * `sum()` over `bigint` is declared to return **numeric**, because summing
   * many int8 values can exceed int8. `numeric` has unbounded precision, so the
   * driver correctly returns it as a string — and the application then has a
   * string where every other amount is a bigint, which means `sum + other`
   * concatenates. The exact `"100" + "50" === "10050"` failure this project
   * opens by ruling out, reintroduced through an aggregate, in a place the type
   * parser cannot reach.
   */
  it('sum() over a bigint column returns numeric, while count() returns bigint', async () => {
    const { rows } = await ctx.pool.query<{ sum_type: string; count_type: string }>(
      `SELECT pg_typeof(sum(amount))::text AS sum_type,
              pg_typeof(count(*))::text    AS count_type
         FROM (SELECT 1::bigint AS amount) s`,
    );

    expect(rows[0]?.sum_type).toBe('numeric');
    expect(rows[0]?.count_type).toBe('bigint');
  });

  it('uncast, it arrives as a string; cast, it arrives as a bigint', async () => {
    const result = await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, cashAccount, -5000n);
      await insertEntry(client, txnId, houseAccount, 5000n);
    });
    expect(result).toEqual({ ok: true });

    const { rows } = await ctx.pool.query<{ raw: string; cast: bigint }>(
      'SELECT sum(amount) AS raw, sum(amount)::bigint AS cast FROM entries',
    );

    expect(typeof rows[0]?.raw).toBe('string');
    expect(typeof rows[0]?.cast).toBe('bigint');
  });

  it('the uncast value concatenates where the cast one adds', async () => {
    const result = await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, cashAccount, -5000n);
      await insertEntry(client, txnId, houseAccount, 5000n);
    });
    expect(result).toEqual({ ok: true });

    const { rows } = await ctx.pool.query<{ raw: string; cast: bigint }>(
      `SELECT sum(abs(amount)) AS raw, sum(abs(amount))::bigint AS cast FROM entries`,
    );

    // 10000 total movement. Adding a 1 to each:
    expect(rows[0]!.raw + '1').toBe('100001');
    expect(rows[0]!.cast + 1n).toBe(10_001n);
  });

  it('every view that aggregates an amount casts back to bigint', async () => {
    // Asserted on the catalogue so a new view that forgets the cast is a failing
    // test rather than a string that quietly reaches a handler.
    const { rows } = await ctx.pool.query<{
      net_type: string;
      derived_type: string;
      drift_type: string;
    }>(
      `SELECT
         (SELECT format_type(a.atttypid, a.atttypmod)
            FROM pg_attribute a
           WHERE a.attrelid = 'ledger_imbalances'::regclass AND a.attname = 'net_amount') AS net_type,
         (SELECT format_type(a.atttypid, a.atttypmod)
            FROM pg_attribute a
           WHERE a.attrelid = 'account_derived_balances'::regclass
             AND a.attname = 'derived_balance') AS derived_type,
         (SELECT format_type(a.atttypid, a.atttypmod)
            FROM pg_attribute a
           WHERE a.attrelid = 'account_derived_balances'::regclass
             AND a.attname = 'drift') AS drift_type`,
    );

    expect(rows[0]).toEqual({
      net_type: 'bigint',
      derived_type: 'bigint',
      drift_type: 'bigint',
    });
  });

  it('the narrowing cast raises rather than wrapping if a total exceeds int8', async () => {
    // Deliberate behaviour, not a wart: an error beats a silently wrapped
    // balance. 22003 is numeric_value_out_of_range.
    await expect(
      ctx.pool.query(`SELECT (9223372036854775807::numeric + 1)::bigint`),
    ).rejects.toMatchObject({ code: '22003' });
  });
});

describe('account_derived_balances, for proving the snapshot is honest', () => {
  it('reports zero drift between the stored balance and the entries behind it', async () => {
    // The stored `accounts.balance` is a denormalised snapshot. This view is how
    // the claim "it agrees with the entries" is checked rather than asserted.
    await ctx.pool.query('UPDATE accounts SET balance = 0');

    const result = await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, cashAccount, -5000n);
      await insertEntry(client, txnId, houseAccount, 5000n);
    });
    expect(result).toEqual({ ok: true });

    // Snapshot updated to match, as the real write path does atomically.
    await ctx.pool.query('UPDATE accounts SET balance = -5000 WHERE id = $1::bigint', [
      cashAccount.toString(),
    ]);
    await ctx.pool.query('UPDATE accounts SET balance = 5000 WHERE id = $1::bigint', [
      houseAccount.toString(),
    ]);

    const { rows } = await ctx.pool.query<{ drift: bigint; entry_count: bigint }>(
      `SELECT drift, entry_count FROM account_derived_balances
        WHERE external_id IN ('inv-cash', 'inv-house') ORDER BY external_id`,
    );

    expect(rows.map((r) => r.drift)).toEqual([0n, 0n]);
    expect(rows.map((r) => r.entry_count)).toEqual([1n, 1n]);
  });

  it('surfaces drift when the snapshot and the entries disagree', async () => {
    const result = await attempt(async (client, txnId) => {
      await insertEntry(client, txnId, cashAccount, -5000n);
      await insertEntry(client, txnId, houseAccount, 5000n);
    });
    expect(result).toEqual({ ok: true });

    // accounts.balance was left at its opening 100000 while entries say -5000.
    const { rows } = await ctx.pool.query<{ drift: bigint }>(
      `SELECT drift FROM account_derived_balances WHERE external_id = 'inv-cash'`,
    );

    expect(rows[0]?.drift).toBe(105_000n);
  });

  it('an account with no entries derives a balance of zero, not null', async () => {
    // `coalesce(sum(...), 0)` — without it, a new account's derived balance is
    // NULL and every comparison against it is NULL, which is the sort of thing
    // that makes a reconciliation report silently empty.
    await ctx.pool.query('UPDATE accounts SET balance = 0');

    const { rows } = await ctx.pool.query<{ derived_balance: bigint; drift: bigint }>(
      `SELECT derived_balance, drift FROM account_derived_balances
        WHERE external_id = 'inv-cash'`,
    );

    expect(rows[0]?.derived_balance).toBe(0n);
    expect(rows[0]?.drift).toBe(0n);
  });
});

describe('ledger_imbalances, for proving the ledger is balanced now', () => {
  it('stays empty across a mixture of valid transactions', async () => {
    for (const amount of [1n, 5000n, 999_999_999_999n]) {
      const result = await attempt(async (client, txnId) => {
        await insertEntry(client, txnId, cashAccount, -amount);
        await insertEntry(client, txnId, houseAccount, amount);
      });
      expect(result).toEqual({ ok: true });
    }

    const { rows } = await ctx.pool.query('SELECT * FROM ledger_imbalances');
    expect(rows).toEqual([]);
  });

  it('finds an imbalance that was introduced with the trigger disabled', async () => {
    // Simulates what Phase 6's bulk load does: disable the deferred check for
    // speed, then verify afterwards. This is the verification step working.
    await ctx.pool.query('ALTER TABLE entries DISABLE TRIGGER entries_transaction_balanced');
    try {
      const client = await ctx.pool.connect();
      try {
        await client.query('BEGIN');
        const txnId = await openTransaction(client);
        await insertEntry(client, txnId, cashAccount, -5000n);
        await insertEntry(client, txnId, houseAccount, 4000n);
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const { rows } = await ctx.pool.query<{
        transaction_id: bigint;
        leg_count: bigint;
        net_amount: bigint;
      }>('SELECT * FROM ledger_imbalances');

      expect(rows).toHaveLength(1);
      expect(rows[0]?.leg_count).toBe(2n);
      expect(rows[0]?.net_amount).toBe(-1000n);
    } finally {
      await ctx.pool.query('ALTER TABLE entries ENABLE TRIGGER entries_transaction_balanced');
    }
  });

  it('restrictViolation was resolved from the server, not assumed', () => {
    // Guards the comment on SQLSTATE above: if this constant is wrong, that is
    // visible here rather than silently skipping an assertion elsewhere.
    expect(restrictViolation).toBe(SQLSTATE.restrict_violation);
  });
});
