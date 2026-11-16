import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * PostgreSQL's `xid8` — a 64-bit transaction id.
 *
 * `xid8` and not `xid`: the 32-bit `xid` wraps around, so a stored value stops
 * being comparable (and starts being *wrong*) after two billion transactions.
 * `xid8` carries the epoch alongside the counter and never wraps, which is what
 * makes it safe to persist. Supplied by `pg_current_xact_id()`; the older
 * `txid_current()` returns a plain `bigint` and loses that guarantee.
 *
 * Carried as a string in JavaScript. It is an identity, never arithmetic, so
 * there is nothing to gain from a bigint and something to lose from implying
 * that adding two of them means anything.
 */
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

/**
 * ## Why account ids are `bigint` and not UUID
 *
 * Phase 3's `advisory` strategy calls `pg_advisory_xact_lock(bigint)`. A bigint
 * id maps to that signature directly. A UUID would have to be hashed down, and
 * the obvious hash — `hashtext()` — returns **int4**. At 100k distinct keys the
 * birthday probability of at least one int4 collision is around 71%, and a
 * collision silently serialises two unrelated accounts against each other. That
 * is exactly the variable the low-contention benchmark profile is meant to
 * isolate, so it cannot also be a source of noise.
 *
 * The usual argument for UUID — client-generated ids, no round trip, no
 * enumeration — is answered by `external_id`: a client-facing opaque string,
 * unique, with the bigint kept internal.
 */

/**
 * Account types. An enum rather than free text because the sign conventions of
 * double entry depend on which side an account sits on, and a typo in a string
 * column would produce a ledger that balances while meaning the wrong thing.
 */
export const accountKind = pgEnum('account_kind', [
  /** A customer's spendable cash. Debits reduce it. */
  'customer_cash',
  /** A customer's holding of one asset, in QUANTITY_SCALE units. */
  'customer_asset',
  /** The brokerage's own cash. The counterparty to customer trades. */
  'house_cash',
  /** The brokerage's own asset inventory. */
  'house_asset',
  /**
   * The boundary account representing the outside world — a funding provider.
   * Money entering the system debits here and credits a customer, which is what
   * keeps SUM(entries.amount) = 0 true globally rather than only per customer.
   */
  'external_funding',
]);

export const accounts = pgTable(
  'accounts',
  {
    id: bigint('id', { mode: 'bigint' }).generatedByDefaultAsIdentity().primaryKey(),

    /** Client-facing opaque identifier. The bigint id is never exposed. */
    externalId: text('external_id').notNull(),

    kind: accountKind('kind').notNull(),

    /**
     * Asset symbol for the `*_asset` kinds, NULL for cash accounts. A CHECK
     * enforces that pairing rather than trusting the application, because an
     * asset account with no symbol is a position in nothing.
     */
    assetSymbol: text('asset_symbol'),

    /**
     * ## The stored balance snapshot — decided in Phase 2, not deferred
     *
     * This column is a **denormalised snapshot**, maintained inside the same
     * transaction as the entries it summarises. The `entries` table remains the
     * source of truth; a committed verification query proves they agree.
     *
     * Why a snapshot rather than a derived view:
     *
     * With no stored balance, the sufficient-funds check becomes
     * `SELECT SUM(amount) FROM entries WHERE account_id = ?` — an aggregate over
     * the account's whole history. Phase 3 then measures how three concurrency
     * strategies serialise an aggregate scan, which at 10M rows swamps the lock
     * behaviour entirely and makes all three look identical for a reason that has
     * nothing to do with locking. The snapshot keeps the check O(1) so the
     * benchmark measures the locks.
     *
     * The cost, stated plainly: this column can drift from the entries if any
     * write path updates one without the other. That is why no code outside the
     * ledger module is allowed to touch it, and why the verification query is
     * part of the evidence rather than a one-off sanity check.
     *
     * In Phase 1 this column is written by the two deliberately naive paths,
     * with no entries behind it at all. That is the point of Phase 1.
     */
    /*
     * `.default(sql`0`)` and not `.default(0n)`: drizzle-kit 0.31.11 serialises
     * its schema snapshot with JSON.stringify, which throws
     * "TypeError: Do not know how to serialize a BigInt" on a bigint literal
     * default. The raw SQL form sidesteps the snapshot entirely and emits the
     * same `DEFAULT 0`.
     */
    balance: bigint('balance', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),

    /**
     * `mode: 'string'` keeps PostgreSQL's microsecond precision. A JavaScript
     * `Date` is millisecond-precision, so round-tripping through one truncates
     * and can manufacture ties — and a tie in a ledger ordering is a
     * non-deterministic running balance, which is a correctness bug.
     */
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_external_id_key').on(t.externalId),

    /**
     * Asset accounts carry a symbol; cash accounts must not. Enforced here so
     * the pairing cannot be violated by any write path, including a manual psql
     * session during a benchmark.
     */
    check(
      'accounts_asset_symbol_matches_kind',
      sql`(${t.kind} IN ('customer_asset', 'house_asset')) = (${t.assetSymbol} IS NOT NULL)`,
    ),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

/**
 * What a ledger transaction was for. Not free text: the kind determines which
 * account kinds are legal on each leg, and a typo in a string column would
 * produce a transaction that balances while meaning something else.
 */
export const transactionKind = pgEnum('transaction_kind', [
  /** Money entering the system from a funding provider. */
  'funding',
  /** Money leaving the system to a payout destination. */
  'payout',
  /** A customer buys an asset: cash out, asset in. */
  'buy',
  /** A customer sells an asset: asset out, cash in. */
  'sell',
  /** An internal correction. Never an UPDATE — always a new, opposing transaction. */
  'adjustment',
]);

/**
 * The transaction header. One row per logical movement of money; two or more
 * `entries` rows hang off it and must sum to zero.
 *
 * Exists for two reasons beyond grouping:
 *
 * 1. A foreign key from `entries.transaction_id` means an entry cannot reference
 *    a transaction that was never opened. Without the header, `transaction_id`
 *    would be an unconstrained bigint and a typo would silently create a new
 *    one-legged "transaction".
 * 2. `created_xid` is what makes the append-only rule enforceable. See below.
 */
export const ledgerTransactions = pgTable('ledger_transactions', {
  id: bigint('id', { mode: 'bigint' }).generatedByDefaultAsIdentity().primaryKey(),

  kind: transactionKind('kind').notNull(),

  /**
   * The id of the **database** transaction that created this row, captured by
   * `pg_current_xact_id()`.
   *
   * This is the mechanism behind "you cannot append to an already-committed
   * transaction". A trigger on `entries` rejects any insert whose parent's
   * `created_xid` differs from the current `pg_current_xact_id()` — meaning
   * entries can only be added by the same database transaction that opened the
   * ledger transaction, and never afterwards.
   *
   * Why that rule needs to exist at all: the deferred `SUM(amount) = 0` check
   * is per `transaction_id`, so a later transaction appending a *balanced pair*
   * of entries to a settled transaction would pass it cleanly. The books would
   * still balance and history would have changed. This is the first thing a
   * reviewer with fintech experience asks about, and the sum check alone does
   * not answer it.
   */
  createdXid: xid8('created_xid')
    .notNull()
    .default(sql`pg_current_xact_id()`),

  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export type LedgerTransaction = typeof ledgerTransactions.$inferSelect;

/**
 * Debit or credit. Denormalised from the sign of `amount`, and a CHECK enforces
 * that the two agree — a denormalised column with nothing keeping it honest is
 * the exact mistake this repo argues against.
 *
 * Sign convention, fixed here: **a debit is negative, a credit is positive.**
 * One convention, stated once, so that `SUM(amount)` over any transaction is
 * zero and `SUM(amount)` over any account is its balance. The accounting
 * convention where a debit is positive on an asset account and negative on a
 * liability account is correct bookkeeping and wrong for this: it makes the
 * zero-sum invariant depend on the account's type, which cannot be expressed in
 * a single CHECK constraint.
 */
export const entryDirection = pgEnum('entry_direction', ['debit', 'credit']);

export const entries = pgTable(
  'entries',
  {
    id: bigint('id', { mode: 'bigint' }).generatedByDefaultAsIdentity().primaryKey(),

    transactionId: bigint('transaction_id', { mode: 'bigint' })
      .notNull()
      .references(() => ledgerTransactions.id),

    accountId: bigint('account_id', { mode: 'bigint' })
      .notNull()
      .references(() => accounts.id),

    /**
     * Signed, in minor units. Negative for a debit, positive for a credit.
     * `bigint` — never numeric, never a float. See CONVENTIONS.md.
     */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),

    direction: entryDirection('direction').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /**
     * **This index is not an optimisation; the benchmark is meaningless without
     * it.**
     *
     * The deferred constraint trigger evaluates
     * `SUM(amount) ... WHERE transaction_id = ?` at commit time, once per
     * inserted row. Unindexed, that is a sequential scan of `entries`. Once the
     * ~10M-row seed exists, all three Phase 3 concurrency strategies would be
     * measuring "how fast can PostgreSQL scan 10M rows at commit" —
     * *identically* — and the comparison that is the whole point of Phase 3
     * would be worthless for a reason having nothing to do with locking.
     *
     * Created with the table, in the same migration, for that reason.
     */
    index('entries_transaction_id_idx').on(t.transactionId),

    /**
     * No index on `(account_id, created_at, id)` yet, deliberately. Phase 6
     * measures the account-statement query *before* indexing it and records the
     * plan change; adding the index here would delete that result.
     */

    /** A zero-amount entry carries no information and would pass the sum check. */
    check('entries_amount_nonzero', sql`${t.amount} <> 0`),

    /**
     * The denormalised `direction` must agree with the sign of `amount`.
     * Enforced by the database, so the two cannot drift no matter which write
     * path — or which psql session — produced the row.
     */
    check('entries_direction_matches_sign', sql`(${t.direction} = 'debit') = (${t.amount} < 0)`),
  ],
);

export type Entry = typeof entries.$inferSelect;
export type NewEntry = typeof entries.$inferInsert;
