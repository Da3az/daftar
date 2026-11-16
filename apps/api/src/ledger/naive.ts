import type pg from 'pg';

/**
 * # Phase 1 — three cash-debit implementations, two of them deliberately wrong
 *
 * These are permanent deliverables, not stepping stones. A described failure is
 * marketing; a runnable one is evidence. Each is selected per request by a flag,
 * so a reviewer flips a header and watches the invariant break, then flips it
 * back and watches it hold — no restart, no rebuild.
 *
 * ## The two naive paths fail in *different* ways, and the difference is the point
 *
 * They are often lumped together as "the race condition". They are not the same
 * bug, and conflating them gives away that you have not understood the isolation
 * level.
 *
 * ### `naiveOverdraft` — overdrafts, but zero lost updates
 *
 * ```sql
 * -- app: SELECT balance; if (balance < amount) reject;
 * UPDATE accounts SET balance = balance - $1 WHERE id = $2
 * ```
 *
 * The check is stale by the time the write lands, so concurrent debits all pass
 * a check that only one of them should have. The balance goes **negative**.
 *
 * But the `UPDATE` itself loses nothing. Under READ COMMITTED, when an `UPDATE`
 * finds a row that a concurrent transaction has modified and committed,
 * PostgreSQL does not operate on the stale snapshot — it waits for that
 * transaction, then **re-evaluates the row against the new version**. So
 * `balance = balance - $1` applies to the committed value, not the value this
 * transaction first saw. The PostgreSQL documentation illustrates exactly this
 * with a bank-balance example.
 *
 * The consequence: with N concurrent debits of X from a balance of B, the final
 * balance is **exactly** `B - N*X`. Arithmetically correct, just negative. No
 * money is created or destroyed; the account is merely allowed to go overdrawn.
 *
 * ### `naiveLostUpdate` — loses updates, and creates money from nothing
 *
 * ```sql
 * -- app: SELECT balance;  const next = balance - amount;
 * UPDATE accounts SET balance = $1 WHERE id = $2   -- $1 is an absolute value
 * ```
 *
 * Here the new value is computed in JavaScript from a snapshot and written as a
 * literal. PostgreSQL has nothing to re-evaluate: the statement says "set it to
 * 950", and it does. Every concurrent writer computes `1000 - 50` from the same
 * stale read and writes 950. Nine of ten debits vanish.
 *
 * The final balance is **greater than** `B - N*X`. Money that was debited is
 * still in the account. That is a solvency hole, not an overdraft.
 *
 * ### `guardedAtomic` — correct for this invariant
 *
 * ```sql
 * UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1
 * ```
 *
 * One statement. The guard and the decrement are evaluated against the same row
 * version by the same statement, so there is no window between them. Zero rows
 * updated means insufficient funds — reported by the database's own count, not
 * by an application check that could be stale.
 *
 * This is correct for *overdraft prevention*. It is not yet a ledger: there is no
 * double entry, no audit trail, and nothing proving the money went somewhere.
 * That is Phase 2.
 */

export type DebitStrategy = 'naive_overdraft' | 'naive_lost_update' | 'guarded_atomic';

export type DebitOutcome =
  /** The debit was applied. `balanceAfter` is the value the database now holds. */
  | { status: 'applied'; balanceBefore: bigint; balanceAfter: bigint }
  /** Refused for insufficient funds. Nothing was written. */
  | { status: 'insufficient_funds'; balanceBefore: bigint }
  /** No such account. */
  | { status: 'no_such_account' };

export interface DebitRequest {
  accountId: bigint;
  /** Positive, in cash minor units. */
  amount: bigint;
  strategy: DebitStrategy;
  /**
   * Test-only seam, awaited between the read and the write.
   *
   * This exists so the race is provable **deterministically** rather than by
   * scheduler luck. A test that reproduces a race 95% of the time is a red badge
   * on a public repo's front page; this makes the assertion about the code's
   * structure instead. Production never passes it, and because it is a parameter
   * rather than module state, there is no way for it to leak between requests.
   */
  barrier?: () => Promise<void>;
}

/**
 * All three strategies run inside an explicit transaction so that the read and
 * the write of the naive paths are in the same transaction — which is the
 * charitable reading of the mistake. (Being in one transaction is exactly what
 * does *not* save them under READ COMMITTED, which is the lesson.)
 */
export async function debit(client: pg.PoolClient, request: DebitRequest): Promise<DebitOutcome> {
  const { accountId, amount, strategy, barrier } = request;

  if (amount <= 0n) {
    throw new RangeError('debit amount must be positive');
  }

  await client.query('BEGIN');

  try {
    const outcome = await run(client, accountId, amount, strategy, barrier);
    await client.query('COMMIT');
    return outcome;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function run(
  client: pg.PoolClient,
  accountId: bigint,
  amount: bigint,
  strategy: DebitStrategy,
  barrier: (() => Promise<void>) | undefined,
): Promise<DebitOutcome> {
  if (strategy === 'guarded_atomic') {
    // Read first only so an "insufficient funds" response can report the
    // balance. The decision itself is the database's, below.
    const before = await readBalance(client, accountId);
    if (before === null) return { status: 'no_such_account' };

    if (barrier) await barrier();

    /**
     * The guard and the decrement are one statement, so they see one row
     * version. `RETURNING` gives the post-update value from the row the server
     * actually wrote, rather than a value computed in JavaScript that might not
     * match what landed.
     */
    const { rows } = await client.query<{ balance: bigint }>(
      `UPDATE accounts
          SET balance = balance - $1::bigint
        WHERE id = $2::bigint
          AND balance >= $1::bigint
        RETURNING balance`,
      [amount.toString(), accountId.toString()],
    );

    const after = rows[0]?.balance;
    if (after === undefined) {
      // Zero rows: the guard failed. The database refused it, not an `if`.
      return { status: 'insufficient_funds', balanceBefore: before };
    }

    return { status: 'applied', balanceBefore: before, balanceAfter: after };
  }

  const before = await readBalance(client, accountId);
  if (before === null) return { status: 'no_such_account' };

  // THE BUG, for both naive paths: this decision is made against a value that
  // any number of concurrent transactions may already have invalidated.
  if (before < amount) {
    return { status: 'insufficient_funds', balanceBefore: before };
  }

  if (barrier) await barrier();

  if (strategy === 'naive_overdraft') {
    /**
     * Self-referential update: `balance - $1`. Atomic under READ COMMITTED —
     * PostgreSQL re-reads the updated row version, so this loses no updates.
     * It produces overdrafts only.
     */
    const { rows } = await client.query<{ balance: bigint }>(
      `UPDATE accounts
          SET balance = balance - $1::bigint
        WHERE id = $2::bigint
        RETURNING balance`,
      [amount.toString(), accountId.toString()],
    );

    return { status: 'applied', balanceBefore: before, balanceAfter: rows[0]!.balance };
  }

  /**
   * `naive_lost_update`: the new balance is computed here, in JavaScript, from
   * the stale read, and written as an absolute value. PostgreSQL has nothing to
   * re-evaluate. Concurrent writers overwrite each other and debits disappear.
   */
  const computed = before - amount;

  const { rows } = await client.query<{ balance: bigint }>(
    `UPDATE accounts
        SET balance = $1::bigint
      WHERE id = $2::bigint
      RETURNING balance`,
    [computed.toString(), accountId.toString()],
  );

  return { status: 'applied', balanceBefore: before, balanceAfter: rows[0]!.balance };
}

async function readBalance(client: pg.PoolClient, accountId: bigint): Promise<bigint | null> {
  const { rows } = await client.query<{ balance: bigint }>(
    'SELECT balance FROM accounts WHERE id = $1::bigint',
    [accountId.toString()],
  );
  return rows[0]?.balance ?? null;
}
