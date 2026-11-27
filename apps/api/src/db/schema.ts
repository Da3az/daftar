import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
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
  /**
   * Cash a guest has asked to withdraw, parked until the payout rail answers.
   * Still the guest's money — it counts in equity — but no longer spendable.
   * Added by migration 0015.
   */
  'customer_hold',
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
     * What this account is denominated in: `'USD'` for cash, the asset symbol
     * for a position.
     *
     * A GENERATED column derived from `asset_symbol`, so it cannot drift from it
     * and there is no second field to keep in sync. It exists to be the target
     * of a composite foreign key from `entries (account_id, unit)`, which makes
     * an entry whose unit disagrees with its account **unrepresentable** rather
     * than merely rejected.
     *
     * Declared here for type inference and migration diffing; the column is
     * created in migration 0004, because drizzle-kit cannot emit
     * `GENERATED ALWAYS AS ... STORED`.
     */
    unit: text('unit')
      .notNull()
      .generatedAlwaysAs(sql`coalesce(asset_symbol, 'USD')`),

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
     * Redundant with the primary key on `id` alone, deliberately: it is the
     * referenced target of `entries`' composite foreign key, and PostgreSQL
     * requires a unique constraint on exactly the referenced columns.
     */
    unique('accounts_id_unit_key').on(t.id, t.unit),

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
  /** Cash moved from a guest's cash account into their hold account for a withdrawal. */
  'hold',
  /** A failed withdrawal's hold returned to the guest's cash account. */
  'release',
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
     * `bigint` — never numeric, never a float.
     */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),

    direction: entryDirection('direction').notNull(),

    /**
     * What `amount` is denominated in: `'USD'` for cash, an asset symbol for a
     * quantity.
     *
     * The balance check groups by this, so **every unit in a transaction must
     * independently sum to zero**. Without it, a four-leg buy would be checked
     * as `-notional + notional + quantity - quantity = 0` — adding cents to
     * satoshis, which sums to zero and means nothing.
     *
     * This is not FX. There is one currency and no conversion; an asset quantity
     * is a different commodity, not a different currency, and no rate is ever
     * applied between two units inside the ledger. The price linking them is
     * frozen into the order and shows up only as the cash leg's amount.
     */
    unit: text('unit').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /**
     * The entry's unit must be the account's unit. Enforced by a composite
     * foreign key rather than a trigger, so the mismatch is unrepresentable
     * rather than caught — and so the planner knows about it.
     *
     * Needed because per-unit `SUM = 0` alone would not catch it: two BTC legs
     * sitting on cash accounts could still balance each other.
     */
    foreignKey({
      name: 'entries_account_unit_fk',
      columns: [t.accountId, t.unit],
      foreignColumns: [accounts.id, accounts.unit],
    }),

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

/**
 * The tradable asset list. Small and fixed — this is a brokerage demo, not an
 * exchange.
 *
 * `referencePrice` is the price the **order path** uses. It is read from this
 * table and nothing else: no feed, no cache, no network call, inside the
 * measured write path.
 *
 * That is the rule the whole project's reproducibility rests on. Live prices
 * exist in the UI for display, and they are updated into this table out of band
 * by a separate process. If the order endpoint looked up a live price, every
 * benchmark run would produce different amounts and no evidence file would be
 * reproducible — the "before" and "after" numbers would differ because the
 * market moved, not because the code changed. Benchmarks run against this table
 * with no feed attached at all.
 */
export const instruments = pgTable('instruments', {
  symbol: text('symbol').primaryKey(),

  displayName: text('display_name').notNull(),

  /**
   * Cash minor units per **one whole unit** of the asset. So BTC at 95,432.17
   * is 9_543_217 — not per-satoshi, which would need ten more digits of scale
   * to express a cent.
   */
  referencePrice: bigint('reference_price', { mode: 'bigint' }).notNull(),

  referencePriceAt: timestamp('reference_price_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export type Instrument = typeof instruments.$inferSelect;

export const orderSide = pgEnum('order_side', ['buy', 'sell']);

export const orderStatus = pgEnum('order_status', [
  /** Accepted, ledger entries written, awaiting settlement confirmation. */
  'pending',
  /** A settlement webhook confirmed it. */
  'settled',
  /** Rejected before any entries were written. */
  'rejected',
]);

export const orders = pgTable(
  'orders',
  {
    id: bigint('id', { mode: 'bigint' }).generatedByDefaultAsIdentity().primaryKey(),

    /** Client-facing opaque identifier. */
    externalId: text('external_id').notNull(),

    /** The customer's cash account. Its `external_id` identifies the customer. */
    cashAccountId: bigint('cash_account_id', { mode: 'bigint' })
      .notNull()
      .references(() => accounts.id),

    /** The customer's position account for this symbol. */
    assetAccountId: bigint('asset_account_id', { mode: 'bigint' })
      .notNull()
      .references(() => accounts.id),

    symbol: text('symbol')
      .notNull()
      .references(() => instruments.symbol),

    side: orderSide('side').notNull(),

    /** Asset quantity at QUANTITY_SCALE (1e-8). */
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),

    /**
     * **The frozen price.** Snapshotted from `instruments.reference_price` at
     * the moment the order was accepted, and never re-read.
     *
     * Ledger entries use this number, not a live lookup. Without the freeze, a
     * re-run of the same order would post different amounts, the evidence files
     * would stop being reproducible, and — more seriously — the amount a
     * customer was shown would not be the amount they were charged.
     */
    price: bigint('price', { mode: 'bigint' }).notNull(),

    /** `quantity x price / 1e8`, rounded half-up away from zero. In cash minor units. */
    notional: bigint('notional', { mode: 'bigint' }).notNull(),

    status: orderStatus('status').notNull().default('pending'),

    /** The ledger transaction this order produced. NULL only if rejected. */
    transactionId: bigint('transaction_id', { mode: 'bigint' }).references(
      () => ledgerTransactions.id,
    ),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_external_id_key').on(t.externalId),
    index('orders_cash_account_idx').on(t.cashAccountId, t.createdAt),

    /** A zero or negative quantity is not an order. */
    check('orders_quantity_positive', sql`${t.quantity} > 0`),

    /**
     * A non-positive price would make the notional zero or negative, and a
     * zero-notional order would produce a cash leg of 0 that the
     * `entries_amount_nonzero` CHECK rejects — at COMMIT, after the work. Caught
     * here instead.
     */
    check('orders_price_positive', sql`${t.price} > 0`),
    check('orders_notional_positive', sql`${t.notional} > 0`),

    /** A rejected order has no transaction; anything else must have one. */
    check(
      'orders_transaction_matches_status',
      sql`(${t.status} = 'rejected') = (${t.transactionId} IS NULL)`,
    ),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
