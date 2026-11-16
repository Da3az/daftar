/**
 * PostgreSQL error codes, named.
 *
 * Named because the distinctions below are the whole substance of Phase 3, and
 * a bare `'40001'` in a catch block is unreadable six months later. Conflating
 * these is the clearest signal that someone has not actually run the thing they
 * are describing.
 */

/**
 * **40001 — `serialization_failure`.**
 *
 * The transaction could not be serialised: committing it would produce a result
 * no serial ordering of transactions could have produced. PostgreSQL detected
 * this through Serializable Snapshot Isolation (SSI) read/write dependency
 * tracking, *not* by anyone waiting on a lock.
 *
 * Nothing was stuck. There is no deadlock here. The transaction is simply told
 * "your view of the world turned out to be inconsistent with what committed"
 * and the correct response is to **retry it**, which is why the `serializable`
 * strategy has a retry loop and the others do not.
 *
 * Only arises under SERIALIZABLE (and, for a narrower set of cases,
 * REPEATABLE READ).
 */
export const SERIALIZATION_FAILURE = '40001';

/**
 * **40P01 — `deadlock_detected`.**
 *
 * A genuine cycle in the lock wait-for graph: A holds a lock B wants while B
 * holds a lock A wants. PostgreSQL's deadlock detector woke after
 * `deadlock_timeout` (1s here), found the cycle, and killed one transaction to
 * break it.
 *
 * Unlike 40001, something really was stuck, and it stayed stuck for a full
 * `deadlock_timeout` before anything happened — so a workload producing these
 * is paying a second of latency per occurrence, not microseconds.
 *
 * **This is the code that unordered lock acquisition produces.** Taking locks in
 * a consistent order — which both `pessimistic` and `advisory` do, sorted by
 * account id — makes a cycle impossible by construction, so a 40P01 from those
 * strategies means the ordering has a hole in it. Phase 3's deadlock test
 * deliberately removes the ordering to produce one.
 */
export const DEADLOCK_DETECTED = '40P01';

/**
 * **55P03 — `lock_not_available`.**
 *
 * `NOWAIT` found the row locked, or `lock_timeout` expired while waiting. Not a
 * serialization failure and not a deadlock: the lock holder is making perfectly
 * good progress, this transaction just declined to keep waiting.
 */
export const LOCK_NOT_AVAILABLE = '55P03';

/** **57014 — `query_canceled`.** `statement_timeout` fired. */
export const QUERY_CANCELED = '57014';

/** **23514 — `check_violation`.** A CHECK or a constraint trigger rejected it. */
export const CHECK_VIOLATION = '23514';

/** **23505 — `unique_violation`.** Used by Phase 4's idempotency key. */
export const UNIQUE_VIOLATION = '23505';

/** **23503 — `foreign_key_violation`.** */
export const FOREIGN_KEY_VIOLATION = '23503';

/** **22003 — `numeric_value_out_of_range`.** A `::bigint` cast overflowed. */
export const NUMERIC_VALUE_OUT_OF_RANGE = '22003';

/** **40000 — class 40, "Transaction Rollback".** Prefix shared by 40001/40P01. */
export const TRANSACTION_ROLLBACK_CLASS = '40';

export interface PostgresError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
}

/** Narrow an unknown caught value to something with a SQLSTATE. */
export function sqlstateOf(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/**
 * Is this worth retrying?
 *
 * Both 40001 and 40P01 are retryable, and for the same practical reason: the
 * transaction did nothing wrong and a second attempt is likely to succeed. They
 * are still counted separately, because *which* one a strategy produces says
 * what it is actually doing — and because their costs differ by three orders of
 * magnitude. A 40001 is detected at commit, immediately. A 40P01 costs a full
 * `deadlock_timeout` of waiting first.
 */
export function isRetryable(err: unknown): boolean {
  const code = sqlstateOf(err);
  return code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED;
}
