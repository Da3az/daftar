import { sql } from 'drizzle-orm';
import { bigint, check, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

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
