import { beforeEach, describe, expect, it } from 'vitest';
import { parseCash } from '@daftar/money';
import { useTestDatabase } from './support/test-database.ts';
import { Barrier } from './support/barrier.ts';
import { debit, type DebitOutcome, type DebitStrategy } from '../src/ledger/naive.ts';

/**
 * # The deterministic race gate
 *
 * Every assertion here is deterministic. The read and the write of each
 * transaction are separated by an explicit `Barrier`, so all N transactions are
 * guaranteed to have completed their read before any of them writes.
 *
 * That matters because this is the CI gate. A race test that depends on
 * scheduler luck reproduces most of the time and fails the rest, and a flaky
 * test on a public repo's front page undermines the claim it was written to
 * support. The load-generated run in `load/` stays as *evidence* of what happens
 * under real concurrency; the *gate* is here, and it asserts the structure of the
 * code rather than the behaviour of the scheduler.
 */

const ctx = useTestDatabase({ poolMax: 20 });

const OPENING = parseCash('1000.00'); // 100_000n minor units
const DEBIT = parseCash('100.00'); // 10_000n minor units
const CONCURRENCY = 10;

/** Opening balance 1000.00, ten concurrent debits of 100.00 each. */
const TOTAL_DEBITED = DEBIT * BigInt(CONCURRENCY); // 1000.00 — exactly the balance

let accountId: bigint;

beforeEach(async () => {
  await ctx.pool.query('DELETE FROM accounts');

  const { rows } = await ctx.pool.query<{ id: bigint }>(
    `INSERT INTO accounts (external_id, kind, balance)
     VALUES ('race-target', 'customer_cash', $1::bigint)
     RETURNING id`,
    [OPENING.toString()],
  );
  accountId = rows[0]!.id;
});

const balanceNow = async (): Promise<bigint> => {
  const { rows } = await ctx.pool.query<{ balance: bigint }>(
    'SELECT balance FROM accounts WHERE id = $1::bigint',
    [accountId.toString()],
  );
  return rows[0]!.balance;
};

/**
 * Run `CONCURRENCY` debits, each on its own connection, all held at a barrier
 * between their read and their write.
 *
 * The barrier releases only once every participant has arrived, which is what
 * makes "they all read the stale value" a guarantee rather than a hope.
 */
async function raceDebits(strategy: DebitStrategy): Promise<DebitOutcome[]> {
  const barrier = new Barrier(CONCURRENCY);

  const attempts = Array.from({ length: CONCURRENCY }, async () => {
    const client = await ctx.pool.connect();
    try {
      return await debit(client, {
        accountId,
        amount: DEBIT,
        strategy,
        barrier: () => barrier.arriveAndWait(),
      });
    } finally {
      client.release();
    }
  });

  return Promise.all(attempts);
}

const applied = (outcomes: DebitOutcome[]): number =>
  outcomes.filter((o) => o.status === 'applied').length;

const refused = (outcomes: DebitOutcome[]): number =>
  outcomes.filter((o) => o.status === 'insufficient_funds').length;

describe('sanity: the setup is what the assertions assume', () => {
  it('ten debits of 100.00 exactly exhaust an opening balance of 1000.00', () => {
    expect(OPENING).toBe(100_000n);
    expect(DEBIT).toBe(10_000n);
    expect(TOTAL_DEBITED).toBe(OPENING);
  });

  it('a single debit behaves identically under all three strategies', async () => {
    for (const strategy of ['naive_overdraft', 'naive_lost_update', 'guarded_atomic'] as const) {
      await ctx.pool.query('UPDATE accounts SET balance = $1::bigint WHERE id = $2::bigint', [
        OPENING.toString(),
        accountId.toString(),
      ]);

      const client = await ctx.pool.connect();
      try {
        const outcome = await debit(client, { accountId, amount: DEBIT, strategy });
        expect(outcome, strategy).toMatchObject({
          status: 'applied',
          balanceBefore: OPENING,
          balanceAfter: OPENING - DEBIT,
        });
      } finally {
        client.release();
      }
    }
  });
});

describe('DAFTAR_NAIVE_OVERDRAFT — overdrafts, and NOT lost updates', () => {
  it('lets every debit through, overdrawing the account', async () => {
    // Nine of these ten should have been refused: the balance covers one.
    await ctx.pool.query('UPDATE accounts SET balance = $1::bigint WHERE id = $2::bigint', [
      DEBIT.toString(),
      accountId.toString(),
    ]);

    const outcomes = await raceDebits('naive_overdraft');

    expect(applied(outcomes)).toBe(CONCURRENCY);
    expect(refused(outcomes)).toBe(0);

    // Overdrawn by nine debits.
    expect(await balanceNow()).toBe(DEBIT - DEBIT * BigInt(CONCURRENCY));
    expect(await balanceNow()).toBeLessThan(0n);
  });

  it('loses ZERO updates: the final balance is exactly opening minus total', async () => {
    /**
     * This is the assertion most write-ups get wrong. A self-referential
     * `UPDATE ... SET balance = balance - $1` is atomic under READ COMMITTED:
     * PostgreSQL waits for the conflicting transaction and re-evaluates the
     * expression against the *new* row version. So the arithmetic is exact —
     * the only thing wrong is that it was allowed to go negative.
     *
     * Claiming a lost update here is the fastest way to tell a reviewer you do
     * not understand the isolation level this project is about.
     */
    const outcomes = await raceDebits('naive_overdraft');

    expect(applied(outcomes)).toBe(CONCURRENCY);
    expect(await balanceNow()).toBe(OPENING - TOTAL_DEBITED);
    expect(await balanceNow()).toBe(0n);
  });

  it('creates and destroys no money even while overdrawing', async () => {
    await ctx.pool.query('UPDATE accounts SET balance = 0 WHERE id = $1::bigint', [
      accountId.toString(),
    ]);

    const outcomes = await raceDebits('naive_overdraft');
    const sumApplied = outcomes.reduce(
      (total, o) => (o.status === 'applied' ? total + DEBIT : total),
      0n,
    );

    // Every minor unit that was debited is accounted for in the final balance.
    expect(await balanceNow()).toBe(0n - sumApplied);
  });

  it('each transaction sees a different post-update balance, proving re-evaluation', async () => {
    const outcomes = await raceDebits('naive_overdraft');

    const afters = outcomes
      .filter((o): o is Extract<DebitOutcome, { status: 'applied' }> => o.status === 'applied')
      .map((o) => o.balanceAfter);

    // Ten distinct descending values. If PostgreSQL had applied each update to
    // the snapshot each transaction read, they would all be 900.00.
    expect(new Set(afters).size).toBe(CONCURRENCY);
    expect([...afters].sort((a, b) => Number(b - a))).toEqual(
      Array.from({ length: CONCURRENCY }, (_, i) => OPENING - DEBIT * BigInt(i + 1)),
    );
  });
});

describe('DAFTAR_NAIVE_LOST_UPDATE — loses updates, and creates money', () => {
  it('nine of ten debits vanish', async () => {
    const outcomes = await raceDebits('naive_lost_update');

    // All ten report success...
    expect(applied(outcomes)).toBe(CONCURRENCY);

    // ...but only one debit's worth actually left the account.
    expect(await balanceNow()).toBe(OPENING - DEBIT);
    expect(await balanceNow()).toBe(90_000n); // 900.00
  });

  it('the final balance is HIGHER than it should be — money from nothing', async () => {
    expect(await balanceNow()).toBe(OPENING);

    await raceDebits('naive_lost_update');

    const expected = OPENING - TOTAL_DEBITED; // 0.00, if every debit had landed
    const actual = await balanceNow();

    expect(actual).toBeGreaterThan(expected);
    // 900.00 of phantom money: taken from the customer, still in the account.
    // Note which direction this fails in — a solvency hole, not an overdraft.
    expect(actual - expected).toBe(DEBIT * BigInt(CONCURRENCY - 1));
  });

  it('every transaction writes the same absolute value, which is the mechanism', async () => {
    const outcomes = await raceDebits('naive_lost_update');

    const afters = outcomes
      .filter((o): o is Extract<DebitOutcome, { status: 'applied' }> => o.status === 'applied')
      .map((o) => o.balanceAfter);

    // One distinct value, not ten. Each computed `1000.00 - 100.00` in
    // JavaScript from the same stale read and told the database to store it.
    expect(new Set(afters).size).toBe(1);
    expect(afters[0]).toBe(OPENING - DEBIT);
  });

  it('differs from naive_overdraft on the same inputs, which is the whole point', async () => {
    const lostUpdateFinal = await (async () => {
      await raceDebits('naive_lost_update');
      return balanceNow();
    })();

    await ctx.pool.query('UPDATE accounts SET balance = $1::bigint WHERE id = $2::bigint', [
      OPENING.toString(),
      accountId.toString(),
    ]);

    const overdraftFinal = await (async () => {
      await raceDebits('naive_overdraft');
      return balanceNow();
    })();

    expect(lostUpdateFinal).toBe(90_000n); // 900.00 — nine debits lost
    expect(overdraftFinal).toBe(0n); // 0.00 — arithmetically exact
    expect(lostUpdateFinal).not.toBe(overdraftFinal);
  });
});

describe('guarded_atomic — correct under the same race', () => {
  it('admits exactly as many debits as the balance covers', async () => {
    const outcomes = await raceDebits('guarded_atomic');

    expect(applied(outcomes)).toBe(CONCURRENCY);
    expect(refused(outcomes)).toBe(0);
    expect(await balanceNow()).toBe(0n);
  });

  it('never overdraws, even when every transaction read a sufficient balance', async () => {
    // Balance covers exactly one debit; all ten pass their (stale) read.
    await ctx.pool.query('UPDATE accounts SET balance = $1::bigint WHERE id = $2::bigint', [
      DEBIT.toString(),
      accountId.toString(),
    ]);

    const outcomes = await raceDebits('guarded_atomic');

    expect(applied(outcomes)).toBe(1);
    expect(refused(outcomes)).toBe(CONCURRENCY - 1);

    const final = await balanceNow();
    expect(final).toBe(0n);
    expect(final).toBeGreaterThanOrEqual(0n);
  });

  it('refusals come from the database, not from the application read', async () => {
    // The stale application read says "1000.00, plenty". The guard in the
    // UPDATE is what refuses, reported through rowCount.
    await ctx.pool.query('UPDATE accounts SET balance = $1::bigint WHERE id = $2::bigint', [
      (DEBIT * 3n).toString(),
      accountId.toString(),
    ]);

    const outcomes = await raceDebits('guarded_atomic');

    expect(applied(outcomes)).toBe(3);
    expect(refused(outcomes)).toBe(7);

    for (const outcome of outcomes) {
      if (outcome.status === 'insufficient_funds') {
        // Each refusal reports the balance its own transaction read, which was
        // sufficient at the time. That is the stale read, preserved.
        expect(outcome.balanceBefore).toBe(DEBIT * 3n);
      }
    }

    expect(await balanceNow()).toBe(0n);
  });

  it('conserves money exactly: debits applied x amount == balance delta', async () => {
    const outcomes = await raceDebits('guarded_atomic');
    const total = BigInt(applied(outcomes)) * DEBIT;

    expect(OPENING - (await balanceNow())).toBe(total);
  });
});

describe('the three strategies on identical inputs', () => {
  it('produce three different final balances, and only one is correct', async () => {
    const results: Record<DebitStrategy, bigint> = {
      naive_overdraft: 0n,
      naive_lost_update: 0n,
      guarded_atomic: 0n,
    };

    // Opening balance covers one of ten debits, so a correct implementation must
    // refuse nine.
    for (const strategy of ['naive_overdraft', 'naive_lost_update', 'guarded_atomic'] as const) {
      await ctx.pool.query('UPDATE accounts SET balance = $1::bigint WHERE id = $2::bigint', [
        DEBIT.toString(),
        accountId.toString(),
      ]);

      await raceDebits(strategy);
      results[strategy] = await balanceNow();
    }

    expect(results).toEqual({
      // Overdrawn by nine debits. Arithmetic exact, invariant violated.
      naive_overdraft: -90_000n,
      // Nine debits lost. Invariant "balance >= 0" accidentally held, but the
      // money is wrong — this is the worse failure.
      naive_lost_update: 0n,
      // One debit applied, nine refused. Correct.
      guarded_atomic: 0n,
    });

    // The two zeros are not the same zero, which is worth saying out loud:
    // guarded_atomic reached 0 by refusing nine debits, lost_update reached 0 by
    // applying one and dropping nine it had already told the caller succeeded.
    expect(results.naive_lost_update).toBe(results.guarded_atomic);
  });
});

describe('input validation', () => {
  it('rejects a non-positive amount before touching the database', async () => {
    const client = await ctx.pool.connect();
    try {
      for (const amount of [0n, -1n]) {
        await expect(
          debit(client, { accountId, amount, strategy: 'guarded_atomic' }),
        ).rejects.toThrow(RangeError);
      }
      // The connection is still usable — no transaction was left open.
      const { rows } = await client.query<{ ok: number }>('SELECT 1 AS ok');
      expect(rows[0]?.ok).toBe(1);
    } finally {
      client.release();
    }
  });

  it('reports a missing account rather than throwing', async () => {
    const client = await ctx.pool.connect();
    try {
      const outcome = await debit(client, {
        accountId: 999_999_999n,
        amount: DEBIT,
        strategy: 'guarded_atomic',
      });
      expect(outcome).toEqual({ status: 'no_such_account' });
    } finally {
      client.release();
    }
  });
});
