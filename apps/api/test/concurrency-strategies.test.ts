import { beforeEach, describe, expect, it } from 'vitest';
import { parseCash } from '@daftar/money';
import { useTestDatabase } from './support/test-database.ts';
import { resetLedger } from './support/reset.ts';
import { Barrier } from './support/barrier.ts';
import { post, UnbalancedTransactionError, type PostResult } from '../src/ledger/post.ts';
import { DEADLOCK_DETECTED, SERIALIZATION_FAILURE } from '../src/ledger/sqlstate.ts';
import { LEDGER_CONCURRENCY_MODES, type LedgerConcurrencyMode } from '../src/env.ts';

/**
 * # All three strategies are correct; they differ in how
 *
 * Every correctness assertion below runs against **all three** modes, because
 * the claim of Phase 3 is that the choice is a trade-off and not an upgrade. A
 * suite that only tested the default would be asserting that the default works,
 * which is a much smaller claim.
 *
 * The strategy-specific tests at the bottom are about *mechanism*: which
 * SQLSTATE each one produces, whether it retries, and what happens when the
 * lock ordering is removed.
 */

const ctx = useTestDatabase({ poolMax: 30 });

const OPENING = parseCash('1000.00'); // 100_000n
const AMOUNT = parseCash('100.00'); // 10_000n

let customer: bigint;
let house: bigint;
let external: bigint;

beforeEach(async () => {
  await resetLedger(ctx.pool);

  const { rows } = await ctx.pool.query<{ id: bigint; external_id: string }>(
    `INSERT INTO accounts (external_id, kind, balance) VALUES
       ('cust', 'customer_cash', $1::bigint),
       ('house', 'house_cash', 0),
       ('ext', 'external_funding', 0)
     RETURNING id, external_id`,
    [OPENING.toString()],
  );

  const byName = new Map(rows.map((r) => [r.external_id, r.id]));
  customer = byName.get('cust')!;
  house = byName.get('house')!;
  external = byName.get('ext')!;
});

const balanceOf = async (id: bigint): Promise<bigint> => {
  const { rows } = await ctx.pool.query<{ balance: bigint }>(
    'SELECT balance FROM accounts WHERE id = $1::bigint',
    [id.toString()],
  );
  return rows[0]!.balance;
};

const ledgerIsBalanced = async (): Promise<boolean> => {
  const { rows } = await ctx.pool.query('SELECT * FROM ledger_imbalances');
  return rows.length === 0;
};

const driftRows = async (): Promise<{ external_id: string; drift: bigint }[]> => {
  const { rows } = await ctx.pool.query<{ external_id: string; drift: bigint }>(
    'SELECT external_id, drift FROM account_derived_balances WHERE drift <> 0',
  );
  return rows;
};

/** A customer spending cash: cash out of the customer, into the house. */
const spend = (mode: LedgerConcurrencyMode, amount = AMOUNT) => ({
  kind: 'buy' as const,
  legs: [
    { accountId: customer, amount: -amount },
    { accountId: house, amount },
  ],
  requireNonNegative: [customer],
  mode,
});

describe.each(LEDGER_CONCURRENCY_MODES)('%s — correctness', (mode) => {
  it('posts a balanced transaction and updates both snapshots', async () => {
    const result = await post(ctx.pool, spend(mode));

    expect(result.status).toBe('posted');
    expect(result.attempts).toBe(1);

    expect(await balanceOf(customer)).toBe(OPENING - AMOUNT);
    expect(await balanceOf(house)).toBe(AMOUNT);
  });

  it('writes both legs, and they sum to zero', async () => {
    await post(ctx.pool, spend(mode));

    const { rows } = await ctx.pool.query<{ n: bigint; net: bigint }>(
      'SELECT count(*) AS n, sum(amount)::bigint AS net FROM entries',
    );
    expect(rows[0]).toEqual({ n: 2n, net: 0n });
    expect(await ledgerIsBalanced()).toBe(true);
  });

  it('the stored snapshot agrees with the entries behind it', async () => {
    await ctx.pool.query('UPDATE accounts SET balance = 0');
    await post(ctx.pool, { ...spend(mode), requireNonNegative: [] });

    // Zero drift between accounts.balance and SUM(entries.amount).
    expect(await driftRows()).toEqual([]);
  });

  it('refuses a debit the balance cannot cover, writing nothing', async () => {
    const result = await post(ctx.pool, spend(mode, OPENING + 1n));

    expect(result.status).toBe('insufficient_funds');
    if (result.status === 'insufficient_funds') {
      expect(result.accountId).toBe(customer);
      expect(result.available).toBe(OPENING);
      expect(result.required).toBe(OPENING + 1n);
    }

    expect(await balanceOf(customer)).toBe(OPENING);
    const { rows } = await ctx.pool.query<{ n: bigint }>('SELECT count(*) AS n FROM entries');
    expect(rows[0]?.n).toBe(0n);
  });

  it('allows an account not in requireNonNegative to go negative', async () => {
    // external_funding is negative by exactly the money that has entered the
    // system. A ledger that forbade that would be wrong.
    const result = await post(ctx.pool, {
      kind: 'funding',
      legs: [
        { accountId: external, amount: -AMOUNT },
        { accountId: customer, amount: AMOUNT },
      ],
      requireNonNegative: [],
      mode,
    });

    expect(result.status).toBe('posted');
    expect(await balanceOf(external)).toBe(-AMOUNT);
    expect(await balanceOf(customer)).toBe(OPENING + AMOUNT);
  });

  it('handles more than two legs', async () => {
    const result = await post(ctx.pool, {
      kind: 'buy',
      legs: [
        { accountId: customer, amount: -AMOUNT },
        { accountId: house, amount: AMOUNT / 2n },
        { accountId: external, amount: AMOUNT / 2n },
      ],
      requireNonNegative: [customer],
      mode,
    });

    expect(result.status).toBe('posted');
    expect(await ledgerIsBalanced()).toBe(true);
  });

  it('handles the same account appearing on two legs', async () => {
    // Zero the seeded snapshots first. The fixture writes accounts.balance
    // directly with no entries behind it, so without this the customer's drift
    // is its opening balance — correctly, which is why the drift view exists.
    await ctx.pool.query('UPDATE accounts SET balance = 0');

    const result = await post(ctx.pool, {
      kind: 'adjustment',
      legs: [
        { accountId: customer, amount: -AMOUNT },
        { accountId: customer, amount: AMOUNT / 2n },
        { accountId: house, amount: AMOUNT / 2n },
      ],
      requireNonNegative: [],
      mode,
    });

    expect(result.status).toBe('posted');

    // Three legs were written, but the customer's snapshot moved once, by the
    // net of its two legs: -100.00 + 50.00 = -50.00.
    expect(await balanceOf(customer)).toBe(-(AMOUNT / 2n));
    expect(await balanceOf(house)).toBe(AMOUNT / 2n);

    const { rows } = await ctx.pool.query<{ n: bigint }>('SELECT count(*) AS n FROM entries');
    expect(rows[0]?.n).toBe(3n);

    // And the snapshot still equals SUM(entries) for every account — the net
    // collapse did not lose a leg.
    expect(await driftRows()).toEqual([]);
  });

  it('reports a missing account rather than throwing', async () => {
    const result = await post(ctx.pool, {
      kind: 'buy',
      legs: [
        { accountId: 999_999_999n, amount: -AMOUNT },
        { accountId: house, amount: AMOUNT },
      ],
      mode,
    });

    expect(result.status).toBe('no_such_account');
  });

  it('is exact at magnitudes a float could not hold', async () => {
    const huge = 4_611_686_018_427_387_904n; // 2^62
    await ctx.pool.query('UPDATE accounts SET balance = $1::bigint WHERE id = $2::bigint', [
      huge.toString(),
      customer.toString(),
    ]);

    const result = await post(ctx.pool, spend(mode, huge));
    expect(result.status).toBe('posted');
    expect(await balanceOf(customer)).toBe(0n);
    expect(await balanceOf(house)).toBe(huge);
  });
});

describe.each(LEDGER_CONCURRENCY_MODES)('%s — under contention', (mode) => {
  const CONCURRENCY = 12;

  /** All participants read before any writes, then all race to commit. */
  async function race(amount: bigint): Promise<PostResult[]> {
    const barrier = new Barrier(CONCURRENCY);

    return Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        post(ctx.pool, {
          ...spend(mode, amount),
          // Generous: SERIALIZABLE under 12-way contention on one row legitimately
          // needs several attempts.
          maxAttempts: 25,
          barrier: () => barrier.arriveAndWait(),
        }),
      ),
    );
  }

  it('never overdraws, however many transactions raced', async () => {
    // Balance covers exactly 10 of the 12 attempts.
    await ctx.pool.query('UPDATE accounts SET balance = $1::bigint WHERE id = $2::bigint', [
      (AMOUNT * 10n).toString(),
      customer.toString(),
    ]);

    const results = await race(AMOUNT);

    const posted = results.filter((r) => r.status === 'posted').length;
    const refused = results.filter((r) => r.status === 'insufficient_funds').length;

    expect(posted + refused).toBe(CONCURRENCY);
    expect(posted).toBe(10);
    expect(refused).toBe(2);

    const final = await balanceOf(customer);
    expect(final).toBe(0n);
    expect(final).toBeGreaterThanOrEqual(0n);
  });

  it('conserves money exactly: entries always sum to zero', async () => {
    await race(AMOUNT);

    const { rows } = await ctx.pool.query<{ net: bigint }>(
      'SELECT coalesce(sum(amount), 0)::bigint AS net FROM entries',
    );
    expect(rows[0]?.net).toBe(0n);
    expect(await ledgerIsBalanced()).toBe(true);
  });

  it('the snapshot never drifts from the entries', async () => {
    await ctx.pool.query('UPDATE accounts SET balance = 0');
    await ctx.pool.query('UPDATE accounts SET balance = $1::bigint WHERE id = $2::bigint', [
      (AMOUNT * BigInt(CONCURRENCY)).toString(),
      customer.toString(),
    ]);

    const results = await race(AMOUNT);
    const posted = results.filter((r) => r.status === 'posted').length;

    // The snapshot is only honest if it equals opening + SUM(entries).
    const { rows } = await ctx.pool.query<{ external_id: string; drift: bigint }>(
      'SELECT external_id, drift FROM account_derived_balances ORDER BY external_id',
    );

    const customerDrift = rows.find((r) => r.external_id === 'cust')!.drift;
    // The customer started with a non-zero snapshot and no entries behind it, so
    // its drift is exactly that opening figure — not zero, and that is correct.
    expect(customerDrift).toBe(AMOUNT * BigInt(CONCURRENCY));
    expect(rows.find((r) => r.external_id === 'house')!.drift).toBe(0n);
    expect(posted).toBe(CONCURRENCY);
  });

  it('every posted transaction has exactly two legs', async () => {
    const results = await race(AMOUNT);
    const posted = results.filter((r) => r.status === 'posted').length;

    const { rows } = await ctx.pool.query<{ n: bigint }>('SELECT count(*) AS n FROM entries');
    expect(rows[0]?.n).toBe(BigInt(posted) * 2n);
  });
});

describe('mechanism: which SQLSTATE each strategy produces', () => {
  const CONCURRENCY = 10;

  async function raceCounting(mode: LedgerConcurrencyMode): Promise<{
    serializationFailures: number;
    deadlocks: number;
    maxAttempts: number;
  }> {
    const barrier = new Barrier(CONCURRENCY);

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        post(ctx.pool, {
          ...spend(mode, AMOUNT),
          maxAttempts: 30,
          barrier: () => barrier.arriveAndWait(),
        }),
      ),
    );

    return {
      serializationFailures: results.reduce((n, r) => n + r.serializationFailures, 0),
      deadlocks: results.reduce((n, r) => n + r.deadlocks, 0),
      maxAttempts: Math.max(...results.map((r) => r.attempts)),
    };
  }

  it('serializable produces 40001 and retries; it never deadlocks', async () => {
    const stats = await raceCounting('serializable');

    // Ten transactions all reading and writing one row under SSI: conflicts are
    // the expected outcome, not an anomaly.
    expect(stats.serializationFailures).toBeGreaterThan(0);
    expect(stats.maxAttempts).toBeGreaterThan(1);

    // 40001 is NOT a deadlock. Nothing was stuck; SSI detected a read/write
    // dependency cycle at commit and cancelled one side immediately.
    expect(stats.deadlocks).toBe(0);
  });

  it('pessimistic never produces 40001, because it never uses SSI', async () => {
    const stats = await raceCounting('pessimistic');

    expect(stats.serializationFailures).toBe(0);
    expect(stats.deadlocks).toBe(0);
    // No retries at all: FOR UPDATE waits rather than failing.
    expect(stats.maxAttempts).toBe(1);
  });

  it('advisory never produces 40001 or 40P01 when ids are locked in order', async () => {
    const stats = await raceCounting('advisory');

    expect(stats.serializationFailures).toBe(0);
    expect(stats.deadlocks).toBe(0);
    expect(stats.maxAttempts).toBe(1);
  });
});

describe('the deadlock test: A->B against B->A', () => {
  /**
   * The ordering argument, demonstrated rather than asserted.
   *
   * Two concurrent transfers in opposite directions are the textbook deadlock.
   * They deadlock exactly when one transaction takes A then B while the other
   * takes B then A. `lockOrder()` sorts by account id, so both go low-id-first
   * and a wait-for cycle cannot form.
   *
   * The second test removes the ordering — by hand, at the SQL level — to show
   * that the cycle is real and that the sort is what prevents it. Without that
   * half, "we sort to avoid deadlocks" is an unfalsifiable claim.
   */

  it('ordered acquisition: concurrent A->B and B->A both succeed, no deadlock', async () => {
    const barrier = new Barrier(2);

    const aToB = post(ctx.pool, {
      kind: 'adjustment',
      legs: [
        { accountId: customer, amount: -AMOUNT },
        { accountId: house, amount: AMOUNT },
      ],
      mode: 'pessimistic',
      barrier: () => barrier.arriveAndWait(),
    });

    const bToA = post(ctx.pool, {
      kind: 'adjustment',
      legs: [
        { accountId: house, amount: -AMOUNT },
        { accountId: customer, amount: AMOUNT },
      ],
      mode: 'pessimistic',
      barrier: () => barrier.arriveAndWait(),
    });

    const results = await Promise.all([aToB, bToA]);

    for (const r of results) {
      expect(r.status).toBe('posted');
      expect(r.deadlocks).toBe(0);
      expect(r.attempts).toBe(1);
    }

    // Net zero movement, and the books balance.
    expect(await balanceOf(customer)).toBe(OPENING);
    expect(await balanceOf(house)).toBe(0n);
    expect(await ledgerIsBalanced()).toBe(true);
  });

  it('UNORDERED acquisition deadlocks, with SQLSTATE 40P01 — not 40001', async () => {
    /**
     * Hand-rolled so the lock order is genuinely reversed. `post()` cannot
     * produce this, which is the point.
     *
     * One transaction locks low-then-high, the other high-then-low. The barrier
     * guarantees both hold their first lock before either asks for its second,
     * so the cycle is certain rather than probable — this is a deterministic
     * deadlock, not a flaky one.
     */
    const [low, high] = [customer, house].sort((a, b) => (a < b ? -1 : 1)) as [bigint, bigint];
    const barrier = new Barrier(2);

    // Returns 'ok', or the SQLSTATE the transaction died with.
    const lockInOrder = async (first: bigint, second: bigint): Promise<string> => {
      const client = await ctx.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM accounts WHERE id = $1::bigint FOR UPDATE', [
          first.toString(),
        ]);

        // Both sides now hold exactly one lock.
        await barrier.arriveAndWait();

        await client.query('SELECT id FROM accounts WHERE id = $1::bigint FOR UPDATE', [
          second.toString(),
        ]);
        await client.query('COMMIT');
        return 'ok';
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        return (err as { code?: string }).code ?? 'unknown';
      } finally {
        client.release();
      }
    };

    const outcomes = await Promise.all([lockInOrder(low, high), lockInOrder(high, low)]);

    // PostgreSQL's deadlock detector kills exactly one side to break the cycle.
    const codes = outcomes.filter((o) => o !== 'ok');
    expect(codes).toHaveLength(1);

    // 40P01, deadlock_detected. NOT 40001.
    expect(codes[0]).toBe(DEADLOCK_DETECTED);
    expect(codes[0]).not.toBe(SERIALIZATION_FAILURE);

    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
  }, 20_000);

  it('the two codes are different, and each strategy produces its own', () => {
    // Stated as an assertion because conflating them is the single clearest
    // tell that someone has not run the thing they are describing.
    expect(SERIALIZATION_FAILURE).toBe('40001');
    expect(DEADLOCK_DETECTED).toBe('40P01');
    expect(SERIALIZATION_FAILURE).not.toBe(DEADLOCK_DETECTED);
  });
});

describe('the retry loop', () => {
  it('is bounded: it gives up and surfaces the database error', async () => {
    const CONCURRENCY = 16;
    const barrier = new Barrier(CONCURRENCY);

    // maxAttempts: 1 means no retry at all, so every loser surfaces its 40001.
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        post(ctx.pool, {
          ...spend('serializable', 1n),
          maxAttempts: 1,
          barrier: () => barrier.arriveAndWait(),
        }),
      ),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);

    for (const r of rejected) {
      // The database's own error, with its SQLSTATE intact, so the canonical log
      // line can record it. Not a synthesised "retries exhausted" that loses it.
      expect((r.reason as { code?: string }).code).toBe(SERIALIZATION_FAILURE);
    }
  });

  it('does not retry a non-conflict error', async () => {
    // A constraint violation is a real error. Retrying it would turn one failure
    // into maxAttempts failures and delay the report by the backoff.
    await expect(
      post(ctx.pool, {
        kind: 'buy',
        legs: [
          { accountId: customer, amount: -AMOUNT },
          { accountId: house, amount: AMOUNT },
        ],
        mode: 'serializable',
        maxAttempts: 5,
        beforeWrite: () => {
          // Fail inside the transaction, for a reason that is not a conflict.
          throw Object.assign(new Error('synthetic'), { code: '23514' });
        },
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('reports attempts, so the cost of a strategy is visible per request', async () => {
    const result = await post(ctx.pool, spend('serializable'));
    expect(result.attempts).toBe(1);
    expect(result.serializationFailures).toBe(0);
    expect(result.deadlocks).toBe(0);
  });
});

describe('validation before BEGIN', () => {
  it('rejects legs that do not sum to zero, without opening a transaction', async () => {
    await expect(
      post(ctx.pool, {
        kind: 'buy',
        legs: [
          { accountId: customer, amount: -AMOUNT },
          { accountId: house, amount: AMOUNT - 1n },
        ],
        mode: 'pessimistic',
      }),
    ).rejects.toThrow(UnbalancedTransactionError);

    // No ledger_transactions row was consumed.
    const { rows } = await ctx.pool.query<{ n: bigint }>(
      'SELECT count(*) AS n FROM ledger_transactions',
    );
    expect(rows[0]?.n).toBe(0n);
  });

  it('rejects a single-leg transaction', async () => {
    await expect(
      post(ctx.pool, {
        kind: 'buy',
        legs: [{ accountId: customer, amount: -AMOUNT }],
        mode: 'pessimistic',
      }),
    ).rejects.toThrow(UnbalancedTransactionError);
  });

  it('rejects a zero-amount leg', async () => {
    await expect(
      post(ctx.pool, {
        kind: 'buy',
        legs: [
          { accountId: customer, amount: 0n },
          { accountId: house, amount: 0n },
        ],
        mode: 'pessimistic',
      }),
    ).rejects.toThrow(RangeError);
  });

  it('the database would have caught it anyway — this is just cheaper', async () => {
    // Proof the application check is not load-bearing: bypass it and the
    // deferred trigger still refuses at COMMIT.
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: bigint }>(
        `INSERT INTO ledger_transactions (kind) VALUES ('buy') RETURNING id`,
      );
      const txnId = rows[0]!.id;
      await client.query(
        `INSERT INTO entries (transaction_id, account_id, amount, direction, unit) VALUES
           ($1::bigint, $2::bigint, -10000, 'debit',  'USD'),
           ($1::bigint, $3::bigint,   9999, 'credit', 'USD')`,
        [txnId.toString(), customer.toString(), house.toString()],
      );
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        constraint: 'entries_transaction_balanced',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
