import type pg from 'pg';
import { notional as computeNotional } from '@daftar/money';
import { postWithin, type Leg } from '../ledger/post.ts';
import { isRetryable } from '../ledger/sqlstate.ts';

/**
 * # The matching engine
 *
 * Price-time priority, in PostgreSQL, one database transaction per incoming
 * order.
 *
 * ## Why it runs in the database and not in memory
 *
 * An in-memory book is faster by orders of magnitude and is what a real venue
 * runs. It also has to be rebuilt on restart, replicated between instances, and
 * reconciled against the ledger — three sources of "the book says X, the money
 * says Y". This project's argument is that the money is never wrong, so the
 * book lives where the money lives and they commit together: an order row, the
 * trades it produced, the resting orders it consumed and every ledger entry
 * behind them are one transaction. There is no state to reconcile because there
 * is only one copy of it.
 *
 * The cost is throughput. One market is one lock, so matching is strictly
 * serial per market, and each fill is nine round trips. That is fine for a dozen
 * bots and a handful of guests, and it is the first thing that would have to
 * change for anything larger.
 *
 * ## The lock
 *
 * `SELECT ... FROM markets WHERE symbol = $1 FOR UPDATE`, first, before
 * anything else is read. It does three jobs at once: it reads the market's
 * rules, it serialises every order and cancel on that market, and it is the row
 * the transaction is going to update with the last traded price anyway.
 *
 * Serialising the whole market is what makes the rest of this file simple. The
 * book cannot change between reading the best resting order and filling it; a
 * cancel cannot land between the two; and a participant's open orders — which
 * their available balance is computed from — cannot change under the check.
 *
 * It is also what makes several `postWithin()` calls in one transaction safe.
 * Each sorts its own account locks, but two calls are not ordered relative to
 * each other, so two matching transactions interleaving could deadlock. They
 * cannot interleave: the second is waiting on the market row.
 *
 * ## Funds
 *
 * Two layers, and the second is the authority:
 *
 *  1. **At placement**, a guest's order is checked against
 *     `balance − reservations`, where reservations are computed from their own
 *     open orders. This is what stops ten resting bids against one balance.
 *  2. **At fill**, `postWithin()` refuses any transaction that would leave a
 *     guest's cash or position negative. If a resting order can no longer be
 *     covered — the legacy API moved the money, say — it is cancelled and the
 *     incoming order carries on to the next one.
 *
 * The reservation is arithmetic over rows, not money held in a separate ledger
 * account. That is a deliberate simplification: it is exact under the market
 * lock for everything the exchange does, and layer 2 means that being wrong
 * about it can cancel an order but cannot overdraw an account.
 *
 * Bots are exempt from both. Their accounts go negative the way the house's do,
 * which is what "unlimited balance" means in a ledger that still has to sum to
 * zero: every coin a guest holds is a coin some bot is short.
 */

export type Side = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';
export type OrderStatus = 'open' | 'filled' | 'cancelled';
export type ParticipantKind = 'guest' | 'bot';

/** The one market. Routes default to it; the schema does not assume it. */
export const DEFAULT_MARKET = 'DFT';

/** A guest may rest at most this many orders. Bots police themselves. */
export const MAX_OPEN_ORDERS_PER_GUEST = 50;

/**
 * Ceiling on one order's quantity, at QUANTITY_SCALE: 100,000 coins.
 *
 * A bound for its own sake — nobody needs more — and it keeps every
 * intermediate product in this file many orders of magnitude inside int8, so a
 * `sum(...)::bigint` in a report cannot be made to raise 22003
 * (numeric_value_out_of_range) by one absurd order.
 */
export const MAX_ORDER_QUANTITY = 100_000n * 100_000_000n;

/** Resting orders read per round trip while sweeping the book. */
const SWEEP_BATCH = 50;

const QUANTITY_DIVISOR = 100_000_000n;

export interface Market {
  symbol: string;
  displayName: string;
  tickSize: bigint;
  lotSize: bigint;
  minPrice: bigint;
  maxPrice: bigint;
  openingPrice: bigint;
  lastPrice: bigint;
  lastTradeAt: string | null;
}

export interface MarketRow {
  symbol: string;
  display_name: string;
  tick_size: bigint;
  lot_size: bigint;
  min_price: bigint;
  max_price: bigint;
  opening_price: bigint;
  last_price: bigint;
  last_trade_at: string | null;
}

export const MARKET_COLUMNS = `symbol, display_name, tick_size, lot_size, min_price, max_price,
       opening_price, last_price, last_trade_at`;

export const toMarket = (row: MarketRow): Market => ({
  symbol: row.symbol,
  displayName: row.display_name,
  tickSize: row.tick_size,
  lotSize: row.lot_size,
  minPrice: row.min_price,
  maxPrice: row.max_price,
  openingPrice: row.opening_price,
  lastPrice: row.last_price,
  lastTradeAt: row.last_trade_at,
});

export interface PlaceBookOrderRequest {
  /** Client-chosen id. UNIQUE in the database. */
  externalId: string;
  participantExternalId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  /** At QUANTITY_SCALE (1e-8). */
  quantity: bigint;
  /** Cash minor units per whole coin. Required for `limit`, absent for `market`. */
  limitPrice?: bigint;
}

export interface BookOrder {
  externalId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  limitPrice: bigint | null;
  quantity: bigint;
  filledQuantity: bigint;
  status: OrderStatus;
  cancelReason: string | null;
}

export interface Fill {
  price: bigint;
  quantity: bigint;
  notional: bigint;
  transactionId: bigint;
}

export type PlaceBookOrderResult =
  | { status: 'accepted'; order: BookOrder; fills: Fill[] }
  | { status: 'unknown_market' }
  | { status: 'unknown_participant' }
  | { status: 'invalid_quantity'; lotSize: bigint; maxQuantity: bigint }
  | { status: 'invalid_price'; tickSize: bigint; minPrice: bigint; maxPrice: bigint }
  | { status: 'insufficient_funds'; unit: string; available: bigint; required: bigint }
  | { status: 'too_many_open_orders'; limit: number }
  | { status: 'no_liquidity' };

/** A refusal decided before anything was written. The transaction is rolled back. */
type Refusal = Exclude<PlaceBookOrderResult, { status: 'accepted' }>;

interface Taker {
  id: bigint;
  kind: ParticipantKind;
  cashAccountId: bigint;
  assetAccountId: bigint;
  cashBalance: bigint;
  assetBalance: bigint;
}

interface RestingOrder {
  id: bigint;
  participant_id: bigint;
  participant_kind: ParticipantKind;
  limit_price: bigint;
  remaining: bigint;
  cash_account_id: bigint;
  asset_account_id: bigint;
}

/** The position account for a participant in one market. */
export const positionAccountExternalId = (participantExternalId: string, symbol: string): string =>
  `${participantExternalId}:${symbol}`;

/**
 * Run `work` in one transaction, retrying on a deadlock or serialization
 * failure.
 *
 * Neither should happen — the market lock orders everything the exchange does —
 * but the legacy order path shares these tables and takes account locks of its
 * own, so a 40P01 (deadlock_detected) against it is possible in principle. Three
 * attempts, because a retry loop without a bound is an outage amplifier.
 */
async function inTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<{ commit: boolean; value: T }>,
): Promise<T> {
  const maxAttempts = 3;

  for (let attempt = 1; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { commit, value } = await work(client);
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      return value;
    } catch (err) {
      // ROLLBACK can itself fail if the connection died; the original error is
      // the useful one.
      await client.query('ROLLBACK').catch(() => undefined);
      if (!isRetryable(err) || attempt === maxAttempts) throw err;
    } finally {
      client.release();
    }
  }
}

async function lockMarket(client: pg.PoolClient, symbol: string): Promise<Market | null> {
  const { rows } = await client.query<MarketRow>(
    `SELECT ${MARKET_COLUMNS} FROM markets WHERE symbol = $1 FOR UPDATE`,
    [symbol],
  );
  return rows[0] ? toMarket(rows[0]) : null;
}

async function loadTaker(
  client: pg.PoolClient,
  participantExternalId: string,
  symbol: string,
): Promise<Taker | null> {
  const { rows } = await client.query<{
    id: bigint;
    kind: ParticipantKind;
    cash_account_id: bigint;
    cash_balance: bigint;
    asset_account_id: bigint;
    asset_balance: bigint;
  }>(
    `SELECT p.id, p.kind,
            cash.id       AS cash_account_id,
            cash.balance  AS cash_balance,
            asset.id      AS asset_account_id,
            asset.balance AS asset_balance
       FROM participants p
       JOIN accounts cash  ON cash.id = p.cash_account_id
       JOIN accounts asset ON asset.external_id = p.external_id || ':' || $2
      WHERE p.external_id = $1`,
    [participantExternalId, symbol],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    kind: row.kind,
    cashAccountId: row.cash_account_id,
    assetAccountId: row.asset_account_id,
    cashBalance: row.cash_balance,
    assetBalance: row.asset_balance,
  };
}

export interface Reservations {
  /** Cash committed to open buy orders, at each order's own limit price. */
  cash: bigint;
  /** Coins committed to open sell orders. */
  asset: bigint;
  openOrders: number;
}

/**
 * What a participant's open orders have already spoken for.
 *
 * Computed in JavaScript from the rows rather than as a SQL aggregate, so the
 * cash figure uses `notional()` — the same half-up rounding the fill will use.
 * A SQL `sum(quantity * price / 1e8)` truncates, and a reservation that rounds
 * differently from the charge is a reservation that is a cent short.
 *
 * Reads at most `MAX_OPEN_ORDERS_PER_GUEST` rows for a guest. Not called for
 * bots.
 */
export async function reservationsOf(
  client: pg.Pool | pg.PoolClient,
  participantId: bigint,
  symbol: string,
): Promise<Reservations> {
  const { rows } = await client.query<{ side: Side; limit_price: bigint; remaining: bigint }>(
    `SELECT side, limit_price, quantity - filled_quantity AS remaining
       FROM book_orders
      WHERE participant_id = $1::bigint AND symbol = $2 AND status = 'open'`,
    [participantId.toString(), symbol],
  );

  let cash = 0n;
  let asset = 0n;
  for (const row of rows) {
    if (row.side === 'buy') cash += computeNotional(row.remaining, row.limit_price);
    else asset += row.remaining;
  }

  return { cash, asset, openOrders: rows.length };
}

/**
 * The most coins `cash` can buy at `price`, as a whole number of lots.
 *
 * Floors, then steps down while the *rounded* notional still exceeds the cash:
 * `notional()` rounds half-up, so the floor of the exact quotient can cost half
 * a cent more than there is.
 */
function affordableQuantity(cash: bigint, price: bigint, lotSize: bigint): bigint {
  if (cash <= 0n) return 0n;

  let quantity = (cash * QUANTITY_DIVISOR) / price;
  quantity -= quantity % lotSize;

  while (quantity > 0n && computeNotional(quantity, price) > cash) quantity -= lotSize;
  return quantity;
}

async function cancelResting(client: pg.PoolClient, orderId: bigint, reason: string) {
  await client.query(
    `UPDATE book_orders
        SET status = 'cancelled', cancel_reason = $2, updated_at = now()
      WHERE id = $1::bigint AND status = 'open'`,
    [orderId.toString(), reason],
  );
}

/**
 * The next batch of resting orders the incoming order could trade with, best
 * price first and oldest first within a price.
 *
 * Every row this returns is either filled completely or cancelled before the
 * next batch is read — except the last one touched, which ends the sweep — so
 * re-running the query always makes progress and never returns a row twice.
 */
async function nextResting(
  client: pg.PoolClient,
  symbol: string,
  takerSide: Side,
  limitPrice: bigint | undefined,
): Promise<RestingOrder[]> {
  const buying = takerSide === 'buy';

  const { rows } = await client.query<RestingOrder>(
    `SELECT o.id, o.participant_id, p.kind AS participant_kind, o.limit_price,
            o.quantity - o.filled_quantity AS remaining,
            p.cash_account_id,
            asset.id AS asset_account_id
       FROM book_orders o
       JOIN participants p ON p.id = o.participant_id
       JOIN accounts asset ON asset.external_id = p.external_id || ':' || o.symbol
      WHERE o.symbol = $1
        AND o.side = $2
        AND o.status = 'open'
        AND ($3::bigint IS NULL OR o.limit_price ${buying ? '<=' : '>='} $3::bigint)
      ORDER BY o.limit_price ${buying ? 'ASC' : 'DESC'}, o.id ASC
      LIMIT ${String(SWEEP_BATCH)}`,
    [symbol, buying ? 'sell' : 'buy', limitPrice === undefined ? null : limitPrice.toString()],
  );

  return rows;
}

export async function placeBookOrder(
  pool: pg.Pool,
  request: PlaceBookOrderRequest,
): Promise<PlaceBookOrderResult> {
  if (request.quantity <= 0n) throw new RangeError('quantity must be positive');
  if ((request.type === 'limit') !== (request.limitPrice !== undefined)) {
    throw new RangeError('a limit order carries a limit price; a market order must not');
  }

  return inTransaction<PlaceBookOrderResult>(pool, async (client) => {
    const refuse = (value: Refusal) => ({ commit: false, value });

    const market = await lockMarket(client, request.symbol);
    if (!market) return refuse({ status: 'unknown_market' });

    if (request.quantity % market.lotSize !== 0n || request.quantity > MAX_ORDER_QUANTITY) {
      return refuse({
        status: 'invalid_quantity',
        lotSize: market.lotSize,
        maxQuantity: MAX_ORDER_QUANTITY,
      });
    }

    const limitPrice = request.limitPrice;
    if (
      limitPrice !== undefined &&
      (limitPrice < market.minPrice ||
        limitPrice > market.maxPrice ||
        limitPrice % market.tickSize !== 0n)
    ) {
      return refuse({
        status: 'invalid_price',
        tickSize: market.tickSize,
        minPrice: market.minPrice,
        maxPrice: market.maxPrice,
      });
    }

    const taker = await loadTaker(client, request.participantExternalId, request.symbol);
    if (!taker) return refuse({ status: 'unknown_participant' });

    const buying = request.side === 'buy';
    const limited = taker.kind === 'guest';

    /**
     * What the taker can still spend. Tracked here and decremented per fill,
     * because the ledger's own check is against the *balance* and this one is
     * against the balance less what other open orders have reserved.
     */
    let availableCash = 0n;
    let availableAsset = 0n;

    if (limited) {
      const reserved = await reservationsOf(client, taker.id, request.symbol);

      if (request.type === 'limit' && reserved.openOrders >= MAX_OPEN_ORDERS_PER_GUEST) {
        return refuse({ status: 'too_many_open_orders', limit: MAX_OPEN_ORDERS_PER_GUEST });
      }

      availableCash = taker.cashBalance - reserved.cash;
      availableAsset = taker.assetBalance - reserved.asset;

      if (!buying && availableAsset < request.quantity) {
        return refuse({
          status: 'insufficient_funds',
          unit: request.symbol,
          available: availableAsset < 0n ? 0n : availableAsset,
          required: request.quantity,
        });
      }

      if (buying && limitPrice !== undefined) {
        // The worst case: every coin at the limit price. Fills at better prices
        // cost less, never more.
        const required = computeNotional(request.quantity, limitPrice);
        if (availableCash < required) {
          return refuse({
            status: 'insufficient_funds',
            unit: 'USD',
            available: availableCash < 0n ? 0n : availableCash,
            required,
          });
        }
      }
    }

    /**
     * The order's id, taken before matching so the trades can reference it,
     * while the row itself is inserted afterwards in its final state.
     *
     * Inserting first and updating after would need a market order to exist as
     * `open` for the length of the sweep, which `book_orders_market_never_rests`
     * forbids — and a CHECK cannot be deferred. Writing the row once, already
     * true, keeps that constraint with no exemption.
     */
    const { rows: idRows } = await client.query<{ id: bigint }>(
      `SELECT nextval(pg_get_serial_sequence('book_orders', 'id')) AS id`,
    );
    const orderId = idRows[0]!.id;

    const fills: (Fill & { makerOrderId: bigint })[] = [];
    let remaining = request.quantity;
    /** Set when the sweep ended because the taker ran out of money. */
    let exhausted = false;

    sweep: while (remaining > 0n) {
      const batch = await nextResting(client, request.symbol, request.side, limitPrice);
      if (batch.length === 0) break;

      for (const maker of batch) {
        if (remaining === 0n) break sweep;

        if (maker.participant_id === taker.id) {
          /**
           * Self-trade prevention: cancel the resting order, keep the incoming
           * one. Skipping it instead would leave the participant's own bid
           * above their own ask — a crossed book — and filling it would be a
           * trade that moves nothing and prints a price nobody agreed on.
           */
          await cancelResting(client, maker.id, 'self_trade');
          continue;
        }

        const price = maker.limit_price;
        let quantity = remaining < maker.remaining ? remaining : maker.remaining;
        /** True when the taker's cash, not the book, decided this fill's size. */
        let trimmed = false;

        if (limited && buying) {
          const affordable = affordableQuantity(availableCash, price, market.lotSize);
          if (affordable < quantity) {
            quantity = affordable;
            trimmed = true;
          }
          if (quantity === 0n) {
            exhausted = true;
            break sweep;
          }
        }

        const cash = computeNotional(quantity, price);

        const buyer = buying
          ? { cash: taker.cashAccountId, asset: taker.assetAccountId, limited }
          : {
              cash: maker.cash_account_id,
              asset: maker.asset_account_id,
              limited: maker.participant_kind === 'guest',
            };
        const seller = buying
          ? {
              cash: maker.cash_account_id,
              asset: maker.asset_account_id,
              limited: maker.participant_kind === 'guest',
            }
          : { cash: taker.cashAccountId, asset: taker.assetAccountId, limited };

        /**
         * Four legs, two units, each balancing on its own: cash from buyer to
         * seller, coins from seller to buyer. Exactly the shape of a legacy
         * order, with a second customer where the house used to be.
         */
        const legs: Leg[] = [
          { accountId: buyer.cash, amount: -cash },
          { accountId: seller.cash, amount: cash },
          { accountId: seller.asset, amount: -quantity },
          { accountId: buyer.asset, amount: quantity },
        ];

        const outcome = await postWithin(client, {
          // Named for the aggressor's side, which is how a tape reads.
          kind: request.side,
          legs,
          requireNonNegative: [
            ...(buyer.limited ? [buyer.cash] : []),
            ...(seller.limited ? [seller.asset] : []),
          ],
          /**
           * `advisory`, the shipped default, and not selectable per request
           * here. `serializable` would need this whole transaction opened at
           * that level and retried as a unit, and the market lock already
           * provides the ordering it would be buying.
           */
          mode: 'advisory',
        });

        if (outcome.status === 'no_such_account') {
          throw new Error(
            `exchange fill references a missing account ${String(outcome.accountId)}`,
          );
        }

        if (outcome.status === 'insufficient_funds') {
          const takerShort =
            outcome.accountId === taker.cashAccountId || outcome.accountId === taker.assetAccountId;

          if (takerShort) {
            exhausted = true;
            break sweep;
          }

          // The resting order can no longer be covered. Nothing was written for
          // this fill, so the transaction is clean: withdraw the order and try
          // the next one.
          await cancelResting(client, maker.id, 'insufficient_funds');
          continue;
        }

        await client.query(
          `UPDATE book_orders
              SET filled_quantity = filled_quantity + $2::bigint,
                  status = CASE WHEN filled_quantity + $2::bigint = quantity
                                THEN 'filled' ELSE 'open' END::book_order_status,
                  updated_at = now()
            WHERE id = $1::bigint`,
          [maker.id.toString(), quantity.toString()],
        );

        fills.push({
          makerOrderId: maker.id,
          price,
          quantity,
          notional: cash,
          transactionId: outcome.transactionId,
        });

        remaining -= quantity;
        if (buying) availableCash -= cash;
        else availableAsset -= quantity;

        if (trimmed) {
          exhausted = true;
          break sweep;
        }

        // A partial fill of the resting order means the incoming one is done.
        if (quantity < maker.remaining) break sweep;
      }
    }

    const filledQuantity = request.quantity - remaining;

    if (request.type === 'market' && filledQuantity === 0n) {
      // Nothing traded, so there is nothing to record. Rolled back, which also
      // un-cancels anything the sweep withdrew along the way.
      return refuse(
        exhausted
          ? {
              status: 'insufficient_funds',
              unit: buying ? 'USD' : request.symbol,
              available: buying ? availableCash : availableAsset,
              required: 0n,
            }
          : { status: 'no_liquidity' },
      );
    }

    let status: OrderStatus;
    let cancelReason: string | null = null;

    if (remaining === 0n) {
      status = 'filled';
    } else if (exhausted) {
      status = 'cancelled';
      cancelReason = 'insufficient_funds';
    } else if (request.type === 'market') {
      // Immediate-or-cancel: the book ran out before the order did.
      status = 'cancelled';
      cancelReason = 'no_liquidity';
    } else {
      status = 'open';
    }

    await client.query(
      `INSERT INTO book_orders
         (id, external_id, participant_id, symbol, side, type, limit_price,
          quantity, filled_quantity, status, cancel_reason)
       VALUES ($1::bigint, $2, $3::bigint, $4, $5, $6, $7::bigint,
               $8::bigint, $9::bigint, $10, $11)`,
      [
        orderId.toString(),
        request.externalId,
        taker.id.toString(),
        request.symbol,
        request.side,
        request.type,
        limitPrice === undefined ? null : limitPrice.toString(),
        request.quantity.toString(),
        filledQuantity.toString(),
        status,
        cancelReason,
      ],
    );

    if (fills.length > 0) {
      // One multi-row INSERT, in fill order, so trade ids ascend with the
      // sweep and "the last trade" is unambiguous.
      await client.query(
        `INSERT INTO trades
           (symbol, price, quantity, notional, taker_order_id, maker_order_id,
            taker_side, transaction_id)
         SELECT $1, f.price, f.quantity, f.notional, $2::bigint, f.maker_order_id,
                $3::order_side, f.transaction_id
           FROM unnest($4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[])
                WITH ORDINALITY
                AS f(price, quantity, notional, maker_order_id, transaction_id, position)
          ORDER BY f.position`,
        [
          request.symbol,
          orderId.toString(),
          request.side,
          fills.map((f) => f.price.toString()),
          fills.map((f) => f.quantity.toString()),
          fills.map((f) => f.notional.toString()),
          fills.map((f) => f.makerOrderId.toString()),
          fills.map((f) => f.transactionId.toString()),
        ],
      );

      await client.query(
        `UPDATE markets SET last_price = $2::bigint, last_trade_at = now() WHERE symbol = $1`,
        [request.symbol, fills[fills.length - 1]!.price.toString()],
      );
    }

    return {
      commit: true,
      value: {
        status: 'accepted',
        order: {
          externalId: request.externalId,
          symbol: request.symbol,
          side: request.side,
          type: request.type,
          limitPrice: limitPrice ?? null,
          quantity: request.quantity,
          filledQuantity,
          status,
          cancelReason,
        },
        fills: fills.map(({ price, quantity, notional, transactionId }) => ({
          price,
          quantity,
          notional,
          transactionId,
        })),
      },
    };
  });
}

export type CancelBookOrderResult =
  | { status: 'cancelled' }
  /** No such order, or not this participant's. Deliberately indistinguishable. */
  | { status: 'not_found' }
  /** Already filled or already cancelled. */
  | { status: 'not_open'; current: OrderStatus };

export async function cancelBookOrder(
  pool: pg.Pool,
  request: { participantExternalId: string; orderExternalId: string; reason?: string },
): Promise<CancelBookOrderResult> {
  // Read without a lock, only to learn which market to lock. The status is
  // re-read under the lock below; this value is never trusted.
  const { rows: found } = await pool.query<{ id: bigint; symbol: string }>(
    `SELECT o.id, o.symbol
       FROM book_orders o
       JOIN participants p ON p.id = o.participant_id
      WHERE o.external_id = $1 AND p.external_id = $2`,
    [request.orderExternalId, request.participantExternalId],
  );

  const order = found[0];
  if (!order) return { status: 'not_found' };

  return inTransaction<CancelBookOrderResult>(pool, async (client) => {
    /**
     * The market lock, for the same reason the matcher takes it: a sweep reads
     * a batch of resting orders and then fills them one at a time, and a cancel
     * landing between the read and the fill would be a cancel that reported
     * success on an order that then traded.
     */
    await lockMarket(client, order.symbol);

    const { rows } = await client.query<{ status: OrderStatus }>(
      `UPDATE book_orders
          SET status = 'cancelled', cancel_reason = $2, updated_at = now()
        WHERE id = $1::bigint AND status = 'open'
        RETURNING status`,
      [order.id.toString(), request.reason ?? 'user'],
    );

    if (rows[0]) return { commit: true, value: { status: 'cancelled' } };

    const { rows: current } = await client.query<{ status: OrderStatus }>(
      'SELECT status FROM book_orders WHERE id = $1::bigint',
      [order.id.toString()],
    );

    return { commit: false, value: { status: 'not_open', current: current[0]!.status } };
  });
}
