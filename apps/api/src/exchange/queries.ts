import type pg from 'pg';
import {
  MARKET_COLUMNS,
  reservationsOf,
  toMarket,
  type Market,
  type MarketRow,
  type OrderStatus,
  type OrderType,
  type Side,
} from './engine.ts';

/**
 * # Exchange read models
 *
 * Everything the trading screen polls. None of it takes the market lock: a
 * reader sees a committed snapshot under READ COMMITTED, and a book that is one
 * transaction stale is still a book that existed.
 *
 * Every aggregate over an amount casts back to `bigint` in SQL — `sum(bigint)`
 * is `numeric`, which the driver hands over as a string. See CONVENTIONS.md.
 */

export async function getMarket(pool: pg.Pool, symbol: string): Promise<Market | null> {
  const { rows } = await pool.query<MarketRow>(
    `SELECT ${MARKET_COLUMNS} FROM markets WHERE symbol = $1`,
    [symbol],
  );
  return rows[0] ? toMarket(rows[0]) : null;
}

export interface BookLevel {
  price: bigint;
  /** Total unfilled quantity resting at this price. */
  quantity: bigint;
  orders: number;
}

export interface Book {
  /** Best (highest) first. */
  bids: BookLevel[];
  /** Best (lowest) first. */
  asks: BookLevel[];
}

/** The top `depth` price levels on each side, aggregated. */
export async function getBook(pool: pg.Pool, symbol: string, depth: number): Promise<Book> {
  const { rows } = await pool.query<{
    side: Side;
    limit_price: bigint;
    quantity: bigint;
    orders: number;
  }>(
    `(SELECT side, limit_price,
             sum(quantity - filled_quantity)::bigint AS quantity,
             count(*)::int AS orders
        FROM book_orders
       WHERE symbol = $1 AND side = 'buy' AND status = 'open'
       GROUP BY side, limit_price
       ORDER BY limit_price DESC
       LIMIT $2::int)
     UNION ALL
     (SELECT side, limit_price,
             sum(quantity - filled_quantity)::bigint AS quantity,
             count(*)::int AS orders
        FROM book_orders
       WHERE symbol = $1 AND side = 'sell' AND status = 'open'
       GROUP BY side, limit_price
       ORDER BY limit_price ASC
       LIMIT $2::int)`,
    [symbol, depth],
  );

  const level = (row: (typeof rows)[number]): BookLevel => ({
    price: row.limit_price,
    quantity: row.quantity,
    orders: row.orders,
  });

  return {
    // Each branch is ordered by its own ORDER BY, but UNION ALL makes no
    // promise about the combined order — so each side is sorted here rather
    // than trusted.
    bids: rows
      .filter((r) => r.side === 'buy')
      .map(level)
      .sort((a, b) => (a.price > b.price ? -1 : a.price < b.price ? 1 : 0)),
    asks: rows
      .filter((r) => r.side === 'sell')
      .map(level)
      .sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0)),
  };
}

export interface TapeTrade {
  id: bigint;
  price: bigint;
  quantity: bigint;
  takerSide: Side;
  createdAt: string;
}

/** The most recent trades, newest first. */
export async function getTape(pool: pg.Pool, symbol: string, limit: number): Promise<TapeTrade[]> {
  const { rows } = await pool.query<{
    id: bigint;
    price: bigint;
    quantity: bigint;
    taker_side: Side;
    created_at: string;
  }>(
    `SELECT id, price, quantity, taker_side, created_at
       FROM trades WHERE symbol = $1 ORDER BY id DESC LIMIT $2::int`,
    [symbol, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    price: r.price,
    quantity: r.quantity,
    takerSide: r.taker_side,
    createdAt: r.created_at,
  }));
}

export interface DayStats {
  /** Price of the first trade in the window, or `null` if there was none. */
  open: bigint | null;
  high: bigint | null;
  low: bigint | null;
  volume: bigint;
  trades: number;
}

/** Trailing 24 hours. */
export async function getDayStats(pool: pg.Pool, symbol: string): Promise<DayStats> {
  const { rows } = await pool.query<{
    open: bigint | null;
    high: bigint | null;
    low: bigint | null;
    volume: bigint;
    trades: number;
  }>(
    `SELECT (array_agg(price ORDER BY id ASC))[1] AS open,
            max(price) AS high,
            min(price) AS low,
            coalesce(sum(quantity), 0)::bigint AS volume,
            count(*)::int AS trades
       FROM trades
      WHERE symbol = $1 AND created_at >= now() - interval '24 hours'`,
    [symbol],
  );

  return rows[0]!;
}

export const CANDLE_INTERVALS = { '1m': 60, '5m': 300, '1h': 3600 } as const;
export type CandleInterval = keyof typeof CANDLE_INTERVALS;

export interface Candle {
  /** Bucket start, Unix seconds. */
  time: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volume: bigint;
}

/**
 * OHLC buckets, aggregated from `trades` on read.
 *
 * Not a maintained candles table. At this trade rate the aggregate over one
 * window is a few thousand indexed rows, and a second copy of the price history
 * is a second thing that can disagree with the trades it summarises.
 *
 * `ORDER BY id` inside the aggregates, never `created_at`: every trade from one
 * sweep shares a `now()`, so `created_at` alone ties, and "the first trade in
 * the bucket" would be whichever one the executor happened to visit first.
 */
export async function getCandles(
  pool: pg.Pool,
  symbol: string,
  interval: CandleInterval,
  limit: number,
): Promise<Candle[]> {
  const seconds = CANDLE_INTERVALS[interval];

  const { rows } = await pool.query<{
    time: bigint;
    open: bigint;
    high: bigint;
    low: bigint;
    close: bigint;
    volume: bigint;
  }>(
    `SELECT extract(epoch FROM bucket)::bigint AS time, open, high, low, close, volume
       FROM (
         SELECT date_bin(make_interval(secs => $2::int), created_at, timestamptz '2000-01-01')
                  AS bucket,
                (array_agg(price ORDER BY id ASC))[1]  AS open,
                max(price)                             AS high,
                min(price)                             AS low,
                (array_agg(price ORDER BY id DESC))[1] AS close,
                sum(quantity)::bigint                  AS volume
           FROM trades
          WHERE symbol = $1
            AND created_at >= now() - make_interval(secs => $2::int * $3::int)
          GROUP BY 1
       ) AS buckets
      ORDER BY time`,
    [symbol, seconds, limit],
  );

  return rows.map((r) => ({
    // A Unix timestamp, not money: safely a number until the year 285,616.
    time: Number(r.time),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}

export interface OrderView {
  externalId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  limitPrice: bigint | null;
  quantity: bigint;
  filledQuantity: bigint;
  status: OrderStatus;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A participant's orders, newest first. `openOnly` for the working-orders list. */
export async function listOrders(
  pool: pg.Pool,
  participantId: bigint,
  options: { openOnly: boolean; limit: number },
): Promise<OrderView[]> {
  const { rows } = await pool.query<{
    external_id: string;
    symbol: string;
    side: Side;
    type: OrderType;
    limit_price: bigint | null;
    quantity: bigint;
    filled_quantity: bigint;
    status: OrderStatus;
    cancel_reason: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT external_id, symbol, side, type, limit_price, quantity, filled_quantity,
            status, cancel_reason, created_at, updated_at
       FROM book_orders
      WHERE participant_id = $1::bigint
        AND ($2::boolean IS FALSE OR status = 'open')
      ORDER BY id DESC
      LIMIT $3::int`,
    [participantId.toString(), options.openOnly, options.limit],
  );

  return rows.map((r) => ({
    externalId: r.external_id,
    symbol: r.symbol,
    side: r.side,
    type: r.type,
    limitPrice: r.limit_price,
    quantity: r.quantity,
    filledQuantity: r.filled_quantity,
    status: r.status,
    cancelReason: r.cancel_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export interface FillView {
  tradeId: bigint;
  orderExternalId: string;
  symbol: string;
  /** The participant's own side of the trade, not the aggressor's. */
  side: Side;
  /** `taker` if this participant's order crossed the spread, `maker` if it was resting. */
  liquidity: 'maker' | 'taker';
  price: bigint;
  quantity: bigint;
  notional: bigint;
  createdAt: string;
}

/**
 * A participant's trades, from either side, newest first.
 *
 * Two indexed branches rather than one `JOIN ... ON o.id IN (taker, maker)`:
 * an `IN` across two columns cannot use either order index, so the single-join
 * form scans `trades`.
 */
export async function listFills(
  pool: pg.Pool,
  participantId: bigint,
  limit: number,
): Promise<FillView[]> {
  const { rows } = await pool.query<{
    trade_id: bigint;
    order_external_id: string;
    symbol: string;
    side: Side;
    liquidity: 'maker' | 'taker';
    price: bigint;
    quantity: bigint;
    notional: bigint;
    created_at: string;
  }>(
    `SELECT * FROM (
       SELECT t.id AS trade_id, o.external_id AS order_external_id, t.symbol, o.side,
              'taker' AS liquidity, t.price, t.quantity, t.notional, t.created_at
         FROM book_orders o JOIN trades t ON t.taker_order_id = o.id
        WHERE o.participant_id = $1::bigint
       UNION ALL
       SELECT t.id, o.external_id, t.symbol, o.side,
              'maker', t.price, t.quantity, t.notional, t.created_at
         FROM book_orders o JOIN trades t ON t.maker_order_id = o.id
        WHERE o.participant_id = $1::bigint
     ) AS fills
     ORDER BY trade_id DESC
     LIMIT $2::int`,
    [participantId.toString(), limit],
  );

  return rows.map((r) => ({
    tradeId: r.trade_id,
    orderExternalId: r.order_external_id,
    symbol: r.symbol,
    side: r.side,
    liquidity: r.liquidity,
    price: r.price,
    quantity: r.quantity,
    notional: r.notional,
    createdAt: r.created_at,
  }));
}

export interface Balances {
  cash: bigint;
  /** Cash less what open buy orders have reserved. What a new order can spend. */
  cashAvailable: bigint;
  asset: bigint;
  assetAvailable: bigint;
}

export async function getBalances(
  pool: pg.Pool,
  participant: { id: bigint; externalId: string },
  symbol: string,
): Promise<Balances> {
  const { rows } = await pool.query<{ cash: bigint; asset: bigint | null }>(
    `SELECT cash.balance AS cash, asset.balance AS asset
       FROM accounts cash
       LEFT JOIN accounts asset ON asset.external_id = cash.external_id || ':' || $2
      WHERE cash.external_id = $1`,
    [participant.externalId, symbol],
  );

  const cash = rows[0]?.cash ?? 0n;
  const asset = rows[0]?.asset ?? 0n;

  /*
   * Two statements, not one snapshot, so a fill landing between them can make
   * `available` momentarily disagree with `balance`. That is acceptable for a
   * number on a screen that is refetched every two seconds; the figure an order
   * is actually checked against is computed under the market lock.
   */
  const reserved = await reservationsOf(pool, participant.id, symbol);

  return {
    cash,
    cashAvailable: cash - reserved.cash,
    asset,
    assetAvailable: asset - reserved.asset,
  };
}
