import type pg from 'pg';
import { sum } from '@daftar/money';
import { env, type LedgerConcurrencyMode } from '../env.ts';
import { DEADLOCK_DETECTED, SERIALIZATION_FAILURE, isRetryable, sqlstateOf } from './sqlstate.ts';

/**
 * # The ledger write path
 *
 * One function, three concurrency strategies, selected per request.
 *
 * **All three are correct.** The deliverable of Phase 3 is the trade-off, not a
 * winner: each wins under some contention profile and loses under another, and
 * the benchmark exists to say which, with numbers.
 *
 * What every strategy does, in one database transaction:
 *
 *   1. acquire whatever it acquires, **in ascending account id order**
 *   2. read the stored balances
 *   3. check sufficient funds against them
 *   4. insert the `ledger_transactions` header
 *   5. insert every leg into `entries`
 *   6. update each account's stored balance snapshot
 *   7. COMMIT — at which point the deferred trigger verifies SUM(amount) = 0
 *
 * Step 7 is not free and its cost is inside every number this phase produces: a
 * two-leg transaction pays **two** invocations of the constraint trigger, each
 * running one indexed aggregate over `entries`. Stated here so the locking
 * strategies are not blamed for it.
 *
 * ## Zero network calls
 *
 * Nothing in this file resolves a hostname, reads a clock for business purposes,
 * or calls a price feed. Amounts arrive already computed from a price frozen
 * into the order. That is what keeps the evidence files reproducible: a live
 * lookup here would make every benchmark run produce different amounts.
 */

export interface Leg {
  accountId: bigint;
  /** Signed, in minor units. Negative debits, positive credits. */
  amount: bigint;
}

export type TransactionKind = 'funding' | 'payout' | 'buy' | 'sell' | 'adjustment';

export interface PostRequest {
  kind: TransactionKind;
  /** Two or more legs that sum to zero. */
  legs: Leg[];
  /**
   * Accounts that must not end up negative. Usually the customer's cash account
   * on a buy; not the house account, which is allowed to be short.
   *
   * Explicit rather than "every account", because a correct ledger genuinely
   * does have accounts that go negative — `external_funding` is negative by
   * exactly the amount of money that has entered the system.
   */
  requireNonNegative?: bigint[];
  mode: LedgerConcurrencyMode;
  /** Bounded. An unbounded retry loop is an outage amplifier. */
  maxAttempts?: number;

  /**
   * Test seam: awaited **once, before the first attempt** — before `BEGIN`,
   * before any lock is taken.
   *
   * Its placement is deliberate and was arrived at the hard way. The obvious
   * place for a concurrency-test barrier is between the balance read and the
   * write, which is where Phase 1's naive paths put theirs. Here that
   * **deadlocks `pessimistic` by construction**: the first transaction takes
   * `FOR UPDATE` on the account and then waits at the barrier for N others,
   * while those N are blocked on the lock it is holding and can never arrive.
   * The barrier and the lock wait for each other, and the test hangs rather
   * than failing.
   *
   * So this is a "start together" barrier. It does not pin an interleaving; it
   * removes the stagger, which is all that is needed once every strategy
   * genuinely contends. Phase 1 needed the stronger form because the bug it
   * demonstrates lives precisely in the read-to-write window.
   *
   * Awaited once rather than per attempt: a single-use barrier re-entered by a
   * retry would over-subscribe and throw.
   */
  barrier?: () => Promise<void>;

  /**
   * Test seam: awaited **inside the transaction**, after the balances are read
   * and before anything is written, on every attempt.
   *
   * Exists to inject a failure at a specific point — proving, for instance,
   * that a non-conflict error is not retried. Not usable as a concurrency
   * barrier, for the reason above.
   */
  beforeWrite?: () => Promise<void>;

  /**
   * Extra work to run **in the same database transaction**, after the entries
   * and snapshot updates and before COMMIT.
   *
   * This is how a caller writes its own row — an `orders` row, a Phase 5 outbox
   * row — atomically with the ledger entries it describes. Atomically is the
   * whole point: an order row that exists without its entries, or entries
   * without their order row, is a reconciliation problem that someone discovers
   * later by hand.
   *
   * Runs on **every attempt**, so it must be idempotent with respect to a
   * rolled-back attempt. That is free here, because a retried attempt is a new
   * transaction and the previous one left nothing behind.
   */
  withinTransaction?: (client: pg.PoolClient, transactionId: bigint) => Promise<void>;
}

export interface PostAttemptStats {
  /** 1 means it succeeded first time. */
  attempts: number;
  /** 40001s seen across all attempts. Non-zero only under `serializable`. */
  serializationFailures: number;
  /** 40P01s seen. Non-zero means the lock ordering has a hole in it. */
  deadlocks: number;
}

export type PostResult =
  | ({
      status: 'posted';
      transactionId: bigint;
      /** Post-transaction stored balance per account touched. */
      balances: Map<bigint, bigint>;
    } & PostAttemptStats)
  | ({
      status: 'insufficient_funds';
      accountId: bigint;
      available: bigint;
      required: bigint;
    } & PostAttemptStats)
  | ({ status: 'no_such_account'; accountId: bigint } & PostAttemptStats);

/**
 * Default retry bound, from `LEDGER_MAX_ATTEMPTS`. A caller may override it per
 * request; the benchmark does, to measure the trade-off at several bounds.
 */
export const defaultMaxAttempts = (): number => env.LEDGER_MAX_ATTEMPTS;

export class UnbalancedTransactionError extends Error {
  constructor(net: bigint) {
    super(`legs do not sum to zero: net ${net.toString()}`);
    this.name = 'UnbalancedTransactionError';
  }
}

/**
 * Validate the request before opening a transaction.
 *
 * The database enforces these too, and the database is the authority. Checking
 * here as well is not redundancy for its own sake: a client error that is caught
 * before `BEGIN` costs no transaction id, no WAL, no lock, and no trigger
 * invocation, and it produces a message that names the problem rather than a
 * constraint name.
 */
function validate(request: Pick<PostRequest, 'legs'>): void {
  if (request.legs.length < 2) {
    throw new UnbalancedTransactionError(sum(request.legs.map((l) => l.amount)));
  }

  const net = sum(request.legs.map((l) => l.amount));
  if (net !== 0n) throw new UnbalancedTransactionError(net);

  for (const leg of request.legs) {
    if (leg.amount === 0n) {
      throw new RangeError('a zero-amount leg carries no information');
    }
  }
}

/**
 * Every account this transaction touches, sorted ascending and de-duplicated.
 *
 * **The sort is the deadlock prevention.** Two concurrent transfers A→B and B→A
 * deadlock precisely when one takes A then B while the other takes B then A. If
 * every transaction acquires in the same total order, a wait-for cycle cannot
 * form — there is no "A waits for B waits for A" when both go low-id-first.
 *
 * This is why it is a property of this function rather than of each strategy:
 * `pessimistic` and `advisory` both depend on it, and a strategy that forgot
 * would produce 40P01 under exactly the workload the benchmark runs.
 */
function lockOrder(legs: Leg[]): bigint[] {
  const unique = [...new Set(legs.map((l) => l.accountId))];
  return unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Net change per account, so one account appearing twice is handled. */
function netByAccount(legs: Leg[]): Map<bigint, bigint> {
  const net = new Map<bigint, bigint>();
  for (const leg of legs) {
    net.set(leg.accountId, (net.get(leg.accountId) ?? 0n) + leg.amount);
  }
  return net;
}

/**
 * Full jitter exponential backoff.
 *
 * `random() * base * 2^attempt`, not `base * 2^attempt`. Without the randomness
 * every transaction that lost the same conflict retries at the same instant and
 * collides again — a thundering herd that converts one conflict into a
 * synchronised sequence of them. Full jitter is the variant that spreads
 * retries most evenly.
 *
 * Capped, because `2^n` reaches absurd values quickly and a retry that sleeps
 * for a minute is indistinguishable from a hang.
 */
function backoffMs(attempt: number): number {
  const base = 2;
  const cap = 100;
  return Math.random() * Math.min(cap, base * 2 ** attempt);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function post(pool: pg.Pool, request: PostRequest): Promise<PostResult> {
  validate(request);

  const maxAttempts = request.maxAttempts ?? defaultMaxAttempts();
  const stats: PostAttemptStats = { attempts: 0, serializationFailures: 0, deadlocks: 0 };

  // Once, before the first attempt and before any connection is taken from the
  // pool. See the note on `barrier` above for why it cannot go further in.
  if (request.barrier) await request.barrier();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    stats.attempts = attempt + 1;

    const client = await pool.connect();
    try {
      const outcome = await attemptOnce(client, request);
      return { ...outcome, ...stats };
    } catch (err) {
      const code = sqlstateOf(err);
      if (code === SERIALIZATION_FAILURE) stats.serializationFailures += 1;
      if (code === DEADLOCK_DETECTED) stats.deadlocks += 1;

      // Anything that is not a conflict is a real error — a constraint
      // violation, a dead connection, a bug. Retrying it would turn one failure
      // into `maxAttempts` failures and delay the report by the backoff.
      if (!isRetryable(err)) throw err;

      // Out of attempts: surface the database's own error rather than a
      // synthesised one, so the SQLSTATE reaches the canonical log line.
      if (attempt === maxAttempts - 1) throw err;

      await sleep(backoffMs(attempt));
    } finally {
      client.release();
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new Error('retry loop exited without a result');
}

type AttemptOutcome =
  | { status: 'posted'; transactionId: bigint; balances: Map<bigint, bigint> }
  | { status: 'insufficient_funds'; accountId: bigint; available: bigint; required: bigint }
  | { status: 'no_such_account'; accountId: bigint };

async function attemptOnce(client: pg.PoolClient, request: PostRequest): Promise<AttemptOutcome> {
  if (request.mode === 'serializable') {
    /**
     * Must be the first statement of the transaction: PostgreSQL rejects
     * `SET TRANSACTION ISOLATION LEVEL` once any query has run. `BEGIN
     * ISOLATION LEVEL SERIALIZABLE` sets it as part of opening the transaction,
     * which also saves a round trip.
     */
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  } else {
    await client.query('BEGIN');
  }

  try {
    const outcome = await writeLegs(client, request);

    if (outcome.status !== 'posted') {
      await client.query('ROLLBACK');
      return outcome;
    }

    if (request.withinTransaction) {
      await request.withinTransaction(client, outcome.transactionId);
    }

    await client.query('COMMIT');
    return outcome;
  } catch (err) {
    // ROLLBACK can itself fail if the connection died. Swallow that so the
    // original error — the useful one — is what propagates.
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

export type PostWithinRequest = Pick<
  PostRequest,
  'kind' | 'legs' | 'requireNonNegative' | 'mode' | 'beforeWrite'
>;

export type PostWithinOutcome = AttemptOutcome;

/**
 * Post one ledger transaction **inside a database transaction the caller
 * already owns**. No `BEGIN`, no `COMMIT`, no retry.
 *
 * `post()` is one ledger transaction per database transaction, which is the
 * right shape for an order against the house. The order book needs a different
 * one: an incoming order can fill against several resting orders, each fill is
 * its own balanced ledger transaction, and all of them have to commit or roll
 * back together with the order rows that describe them. That is several ledger
 * transactions in one database transaction — which the append-only trigger
 * permits, because it compares `created_xid` and every header here is opened by
 * the same database transaction that writes its entries.
 *
 * A refusal (`insufficient_funds`, `no_such_account`) is returned **before
 * anything is written**, so the caller's transaction is still clean and it can
 * carry on — cancel the order that could not be covered, try the next one —
 * rather than having to roll back work it wants to keep.
 *
 * The caller owns three things `post()` otherwise provides:
 *
 *  - **Isolation.** `serializable` here acquires nothing, exactly as in
 *    `post()`, and is only meaningful if the caller opened the transaction at
 *    that level.
 *  - **Lock order across calls.** Each call acquires its accounts in ascending
 *    id order, but two calls in one transaction are not ordered relative to
 *    each other. A caller making several must serialise itself some other way;
 *    the matching engine does it with one advisory lock per market, taken first.
 *  - **Retry.** A 40001 or 40P01 propagates to the caller, whose transaction it
 *    aborts.
 */
export async function postWithin(
  client: pg.PoolClient,
  request: PostWithinRequest,
): Promise<PostWithinOutcome> {
  validate(request);
  return writeLegs(client, request);
}

/**
 * Steps 1–6 of the write path: acquire, read, check, header, entries, snapshot.
 * Opens and closes nothing.
 */
async function writeLegs(
  client: pg.PoolClient,
  request: PostWithinRequest,
): Promise<AttemptOutcome> {
  const accountIds = lockOrder(request.legs);
  const net = netByAccount(request.legs);

  await acquire(client, request.mode, accountIds);

  const balances = await readBalances(client, accountIds);
  for (const id of accountIds) {
    if (!balances.has(id)) return { status: 'no_such_account', accountId: id };
  }

  for (const id of request.requireNonNegative ?? []) {
    const after = (balances.get(id) ?? 0n) + (net.get(id) ?? 0n);
    if (after < 0n) {
      return {
        status: 'insufficient_funds',
        accountId: id,
        available: balances.get(id) ?? 0n,
        required: -(net.get(id) ?? 0n),
      };
    }
  }

  if (request.beforeWrite) await request.beforeWrite();

  const { rows: header } = await client.query<{ id: bigint }>(
    'INSERT INTO ledger_transactions (kind) VALUES ($1) RETURNING id',
    [request.kind],
  );
  const transactionId = header[0]!.id;

  /**
   * All legs in one multi-row INSERT. Not a loop: each round trip is a network
   * hop taken while holding every lock this transaction acquired, so a
   * two-statement write holds locks for roughly twice as long as a one
   * statement write and halves throughput under contention — for no reason.
   */
  await client.query(
    `INSERT INTO entries (transaction_id, account_id, amount, direction, unit)
     SELECT $1::bigint, a.account_id, a.amount,
            CASE WHEN a.amount < 0 THEN 'debit' ELSE 'credit' END::entry_direction,
            acc.unit
       FROM unnest($2::bigint[], $3::bigint[]) AS a(account_id, amount)
       JOIN accounts acc ON acc.id = a.account_id`,
    [
      transactionId.toString(),
      request.legs.map((l) => l.accountId.toString()),
      request.legs.map((l) => l.amount.toString()),
    ],
  );

  /**
   * The stored balance snapshot, updated in the same transaction as the
   * entries it summarises. If this and the INSERT above could ever land
   * separately, `accounts.balance` would drift from the ledger — which is the
   * cost of keeping a snapshot at all, and why `account_derived_balances`
   * exists to prove they agree.
   *
   * `balance + delta`, not an absolute value. Under `pessimistic` the row is
   * already locked so either form is safe; under `serializable` the relative
   * form is what lets SSI see the read-write dependency correctly. Writing an
   * absolute computed in JavaScript is the Phase 1 lost-update bug, and it
   * does not stop being that bug because a better isolation level is in force.
   */
  const updated = await client.query<{ id: bigint; balance: bigint }>(
    `UPDATE accounts AS acc
        SET balance = acc.balance + d.delta
       FROM unnest($1::bigint[], $2::bigint[]) AS d(account_id, delta)
      WHERE acc.id = d.account_id
      RETURNING acc.id, acc.balance`,
    [
      [...net.keys()].map((id) => id.toString()),
      [...net.values()].map((delta) => delta.toString()),
    ],
  );

  return {
    status: 'posted',
    transactionId,
    balances: new Map(updated.rows.map((r) => [r.id, r.balance])),
  };
}

/**
 * Acquire whatever the strategy acquires, in ascending account id order.
 *
 * ## Why each lock is taken in its own statement
 *
 * The obvious one-statement forms —
 * `SELECT ... WHERE id = ANY($1) ORDER BY id FOR UPDATE`, or a select list of
 * `pg_advisory_xact_lock()` calls — do **not** guarantee acquisition order.
 * `FOR UPDATE` is applied by the LockRows plan node, and whether the sort runs
 * above or below it is a planner decision that can change with statistics, with
 * the index set, or with a major version. Evaluation order within a select list
 * is likewise unspecified.
 *
 * Relying on either would mean the deadlock-freedom argument rests on a plan
 * shape rather than on the code, and it would hold right up until the Phase 6
 * seed changed the statistics. So each lock is a separate statement, in sorted
 * order, which is unambiguous.
 *
 * The cost is one extra round trip per additional account — for a two-leg order,
 * one extra. That is real and it is in the benchmark numbers, and it is the
 * right trade against a deadlock-freedom claim that is true only by luck.
 */
async function acquire(
  client: pg.PoolClient,
  mode: LedgerConcurrencyMode,
  accountIds: bigint[],
): Promise<void> {
  if (mode === 'serializable') {
    /**
     * Nothing to acquire. SERIALIZABLE takes no extra locks at all — SSI is
     * optimistic, tracking read/write dependencies via predicate locks (SIReadLock)
     * that never block anyone. Conflicts surface at commit as 40001 and the
     * caller retries.
     *
     * This is the strategy's entire character: nothing waits, and under low
     * contention that is close to free, while under high contention the work is
     * done repeatedly and thrown away.
     */
    return;
  }

  if (mode === 'pessimistic') {
    for (const id of accountIds) {
      /**
       * `FOR UPDATE` on the account row.
       *
       * **This is a mutex, and should be described as one.** The stored
       * `balance` column is a snapshot; the authority is the `entries` table,
       * which this lock does not touch. What the lock actually provides is
       * mutual exclusion over "read this account's balance, then write it" —
       * serialising transactions that touch the same account. Calling it
       * "locking the balance" would overstate it.
       */
      await client.query('SELECT id FROM accounts WHERE id = $1::bigint FOR UPDATE', [
        id.toString(),
      ]);
    }
    return;
  }

  for (const id of accountIds) {
    /**
     * `pg_advisory_xact_lock(bigint)` keyed directly on the account id, released
     * automatically at the end of the transaction.
     *
     * **Never `hashtext()`.** It returns int4. At 100k distinct keys the
     * birthday probability of at least one collision is around 71%, and a
     * collision silently serialises two *unrelated* accounts — which is exactly
     * the variable the 1000-account low-contention profile exists to isolate.
     * Account ids are bigint precisely so this call needs no hashing.
     *
     * Unlike `FOR UPDATE` this takes no row lock, so it does not block a
     * concurrent reader of the row and leaves no tuple-level lock behind. The
     * trade is that it protects nothing by itself — it is purely a convention,
     * and any code path that forgets to take it is simply not excluded.
     */
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [id.toString()]);
  }
}

async function readBalances(
  client: pg.PoolClient,
  accountIds: bigint[],
): Promise<Map<bigint, bigint>> {
  const { rows } = await client.query<{ id: bigint; balance: bigint }>(
    'SELECT id, balance FROM accounts WHERE id = ANY($1::bigint[])',
    [accountIds.map((id) => id.toString())],
  );
  return new Map(rows.map((r) => [r.id, r.balance]));
}
