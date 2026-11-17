import type pg from 'pg';
import { notional as computeNotional } from '@daftar/money';
import type { LedgerConcurrencyMode } from '../env.ts';
import { post, type Leg, type PostAttemptStats } from '../ledger/post.ts';

/**
 * # `POST /v1/orders` — the measured write path
 *
 * The SLO is stated against this: **p99 under 200 ms at 50 concurrent virtual
 * users spread over at least 1000 distinct accounts, with the ~10M-row seed
 * loaded.** The account spread is part of the statement, not a footnote: under
 * pessimistic locking on one hot account throughput is bounded by lock hold
 * time, so the same build passes at 1000 accounts and fails at 1.
 *
 * ## Zero network calls, and why it matters more than it sounds
 *
 * The price is read from the `instruments` table and frozen into the order row.
 * No feed, no cache, no HTTP, no DNS. Three things follow:
 *
 *  - **Benchmarks are reproducible.** A live lookup would make every run post
 *    different amounts, so a "before" and an "after" would differ because the
 *    market moved rather than because the code changed.
 *  - **The latency measured is the ledger's.** A p99 that includes a third
 *    party's API is partly a measurement of them.
 *  - **The amount quoted is the amount charged.** Re-reading a price between
 *    quoting and posting is a real customer-facing bug, not a theoretical one.
 */

/**
 * ## The house counterparty is sharded, and it had to be
 *
 * Phase 3's first benchmark against the 10M-row seed found that the account
 * spread made **no difference at all**: pessimistic and advisory sat near
 * 200 orders/s whether the load was spread over 1 account or 1000, and
 * serializable failed 88% of requests with SQLSTATE 40001.
 *
 * The cause was in the schema, not the strategies. Every order is four legs —
 * customer cash, customer position, house cash, house position — and the house
 * side was *two rows* touched by every order ever placed (2,543,857 entries
 * each, against 17,261 on the busiest customer). Spreading three quarters of a
 * transaction does not spread the transaction.
 *
 * So the house accounts are sharded 16 ways, and a customer maps to a fixed
 * shard. Fixed rather than random for two reasons:
 *
 *  1. **Per-account ordering is preserved.** A customer's orders always touch
 *     the same house rows, so no new interleaving is introduced — which matters
 *     for Phase 5's per-account ordering guarantee.
 *  2. **The lock order stays total.** `post()` sorts account ids before
 *     acquiring, so more shards cannot create a wait-for cycle.
 *
 * The house's true position is `SUM` across its shards; the `house_positions`
 * view states that once so no caller has to know about the sharding.
 */
export const HOUSE_SHARDS = 16;

/**
 * `cashAccountId % HOUSE_SHARDS`, as two lowercase hex digits.
 *
 * Keyed on the account id rather than a hash of it: ids are sequential from an
 * identity column, so the modulo distributes them perfectly evenly, and there is
 * no hash to collide. (`hashtext()` would have been the wrong tool here for the
 * same reason it is wrong for advisory locks — it returns int4.)
 */
export const houseShardOf = (cashAccountId: bigint): string =>
  (cashAccountId % BigInt(HOUSE_SHARDS)).toString(16).padStart(2, '0');

export const houseCashExternalId = (shard: string): string => `house:USD:${shard}`;
export const houseAssetShardExternalId = (symbol: string, shard: string): string =>
  `house:${symbol}:${shard}`;

/**
 * The pre-sharding house accounts. Retained, not removed: 10M seeded entries
 * reference them and `entries` is append-only, so deleting them is not an option
 * even in principle. New orders never touch them.
 */
export const HOUSE_CASH_EXTERNAL_ID = 'house:USD';
export const houseAssetExternalId = (symbol: string): string => `house:${symbol}`;

/** A customer's position account for one symbol. */
export const positionExternalId = (cashExternalId: string, symbol: string): string =>
  `${cashExternalId}:${symbol}`;

export interface PlaceOrderRequest {
  /** Client-facing id for the resulting order. Caller-supplied, unique. */
  externalId: string;
  /** The customer's cash account `external_id`. */
  cashAccountExternalId: string;
  symbol: string;
  side: 'buy' | 'sell';
  /** At QUANTITY_SCALE (1e-8). */
  quantity: bigint;
  mode: LedgerConcurrencyMode;
  maxAttempts?: number;
  /** Test seam, forwarded to the ledger write. */
  barrier?: () => Promise<void>;
}

export interface PlacedOrder {
  externalId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: bigint;
  /** The frozen price, in cash minor units per whole unit. */
  price: bigint;
  notional: bigint;
  status: 'pending';
  transactionId: bigint;
  cashBalanceAfter: bigint;
  assetBalanceAfter: bigint;
}

export type PlaceOrderResult =
  | ({ status: 'placed'; order: PlacedOrder } & PostAttemptStats)
  | ({ status: 'insufficient_funds'; available: bigint; required: bigint } & PostAttemptStats)
  | ({ status: 'unknown_account' } & PostAttemptStats)
  | ({ status: 'unknown_instrument' } & PostAttemptStats)
  | ({ status: 'quantity_rounds_to_zero'; quantity: bigint; price: bigint } & PostAttemptStats)
  | ({ status: 'duplicate_external_id' } & PostAttemptStats);

const NO_RETRIES: PostAttemptStats = { attempts: 1, serializationFailures: 0, deadlocks: 0 };

interface Resolved {
  cashAccountId: bigint;
  assetAccountId: bigint;
  houseCashId: bigint;
  houseAssetId: bigint;
  price: bigint;
  cashBalance: bigint;
}

/**
 * Resolve the five ids and the price in **one** round trip, before `BEGIN`.
 *
 * One query rather than five sequential ones: every round trip on this path is
 * network latency inside the p99 the SLO is about, and the lookups are
 * independent. Doing it before `BEGIN` means none of it happens while holding a
 * lock, which is the difference between a lock held for one round trip and one
 * held for six.
 *
 * `LEFT JOIN` throughout so a missing row yields NULL and a specific error,
 * rather than an empty result that cannot say *which* thing was missing.
 */
async function resolve(
  pool: pg.Pool,
  request: PlaceOrderRequest,
): Promise<Resolved | { missing: 'account' | 'instrument' }> {
  /**
   * The house shard depends on `cash.id`, which this query is itself
   * discovering — so the shard is computed in SQL from the joined row rather
   * than in two round trips. `lpad(to_hex(cash.id % $3), 2, '0')` has to match
   * `houseShardOf()` exactly; a test asserts they agree for a range of ids,
   * because two implementations of one mapping is how a shard split silently
   * appears.
   */
  const { rows } = await pool.query<{
    cash_account_id: bigint | null;
    asset_account_id: bigint | null;
    house_cash_id: bigint | null;
    house_asset_id: bigint | null;
    price: bigint | null;
    cash_balance: bigint | null;
  }>(
    `SELECT cash.id           AS cash_account_id,
            asset.id          AS asset_account_id,
            hcash.id          AS house_cash_id,
            hasset.id         AS house_asset_id,
            i.reference_price AS price,
            cash.balance      AS cash_balance
       FROM instruments i
       LEFT JOIN accounts cash  ON cash.external_id  = $1
       LEFT JOIN accounts asset ON asset.external_id = $2
       LEFT JOIN accounts hcash
              ON hcash.external_id = 'house:USD:' || lpad(to_hex(cash.id % $3::bigint), 2, '0')
       LEFT JOIN accounts hasset
              ON hasset.external_id =
                 'house:' || i.symbol || ':' || lpad(to_hex(cash.id % $3::bigint), 2, '0')
      WHERE i.symbol = $4`,
    [
      request.cashAccountExternalId,
      positionExternalId(request.cashAccountExternalId, request.symbol),
      String(HOUSE_SHARDS),
      request.symbol,
    ],
  );

  const row = rows[0];
  if (!row || row.price === null) return { missing: 'instrument' };

  if (
    row.cash_account_id === null ||
    row.asset_account_id === null ||
    row.house_cash_id === null ||
    row.house_asset_id === null
  ) {
    return { missing: 'account' };
  }

  return {
    cashAccountId: row.cash_account_id,
    assetAccountId: row.asset_account_id,
    houseCashId: row.house_cash_id,
    houseAssetId: row.house_asset_id,
    price: row.price,
    cashBalance: row.cash_balance ?? 0n,
  };
}

export async function placeOrder(
  pool: pg.Pool,
  request: PlaceOrderRequest,
): Promise<PlaceOrderResult> {
  if (request.quantity <= 0n) {
    throw new RangeError('quantity must be positive');
  }

  const resolved = await resolve(pool, request);
  if ('missing' in resolved) {
    return resolved.missing === 'instrument'
      ? { status: 'unknown_instrument', ...NO_RETRIES }
      : { status: 'unknown_account', ...NO_RETRIES };
  }

  const { cashAccountId, assetAccountId, houseCashId, houseAssetId, price } = resolved;

  /** Exact integer arithmetic from the frozen price. Half-up away from zero. */
  const notional = computeNotional(request.quantity, price);

  if (notional <= 0n) {
    /**
     * A quantity small enough to round to zero cash — one satoshi of a cheap
     * asset does it. Rejected here rather than at COMMIT, where it would
     * surface as `entries_amount_nonzero` after the transaction had done all
     * its work, and as a constraint name rather than an explanation.
     */
    return {
      status: 'quantity_rounds_to_zero',
      quantity: request.quantity,
      price,
      ...NO_RETRIES,
    };
  }

  /**
   * Four legs, two units, one atomic transaction.
   *
   * A buy: cash leaves the customer and arrives at the house; quantity leaves
   * the house's inventory and arrives at the customer. Each unit balances
   * independently — migration 0004 explains why a single aggregate sum across
   * all four would be meaningless.
   *
   * The house is the counterparty. A real brokerage routes to a venue; this one
   * does not pretend to. House accounts are allowed to go short, which is why
   * they are absent from `requireNonNegative`.
   */
  const buying = request.side === 'buy';
  const cashDelta = buying ? -notional : notional;
  const assetDelta = buying ? request.quantity : -request.quantity;

  const legs: Leg[] = [
    { accountId: cashAccountId, amount: cashDelta },
    { accountId: houseCashId, amount: -cashDelta },
    { accountId: assetAccountId, amount: assetDelta },
    { accountId: houseAssetId, amount: -assetDelta },
  ];

  /**
   * A buy must not overdraw the customer's cash; a sell must not short their
   * position. Both are the customer's side, and nothing else is constrained.
   */
  const requireNonNegative = buying ? [cashAccountId] : [assetAccountId];

  const result = await post(pool, {
    kind: buying ? 'buy' : 'sell',
    legs,
    requireNonNegative,
    mode: request.mode,
    ...(request.maxAttempts === undefined ? {} : { maxAttempts: request.maxAttempts }),
    ...(request.barrier === undefined ? {} : { barrier: request.barrier }),

    /**
     * The order row, written in the **same transaction** as the entries it
     * describes. Not after the commit: an order row without its entries, or
     * entries without their order row, is a reconciliation problem someone
     * finds by hand weeks later.
     */
    withinTransaction: async (client, transactionId) => {
      await client.query(
        `INSERT INTO orders
           (external_id, cash_account_id, asset_account_id, symbol, side,
            quantity, price, notional, status, transaction_id)
         VALUES ($1, $2::bigint, $3::bigint, $4, $5, $6::bigint, $7::bigint, $8::bigint,
                 'pending', $9::bigint)`,
        [
          request.externalId,
          cashAccountId.toString(),
          assetAccountId.toString(),
          request.symbol,
          request.side,
          request.quantity.toString(),
          price.toString(),
          notional.toString(),
          transactionId.toString(),
        ],
      );
    },
  });

  const stats: PostAttemptStats = {
    attempts: result.attempts,
    serializationFailures: result.serializationFailures,
    deadlocks: result.deadlocks,
  };

  if (result.status === 'insufficient_funds') {
    return {
      status: 'insufficient_funds',
      available: result.available,
      required: result.required,
      ...stats,
    };
  }

  if (result.status === 'no_such_account') {
    return { status: 'unknown_account', ...stats };
  }

  return {
    status: 'placed',
    order: {
      externalId: request.externalId,
      symbol: request.symbol,
      side: request.side,
      quantity: request.quantity,
      price,
      notional,
      status: 'pending',
      transactionId: result.transactionId,
      cashBalanceAfter: result.balances.get(cashAccountId) ?? 0n,
      assetBalanceAfter: result.balances.get(assetAccountId) ?? 0n,
    },
    ...stats,
  };
}
