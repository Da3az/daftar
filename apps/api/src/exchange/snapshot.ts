import { formatCash, formatQuantity } from '@daftar/money';
import type pg from 'pg';
import { getBook, getDayStats, getMarket, getTape } from './queries.ts';

/**
 * # The market snapshot
 *
 * Everything the trading screen draws — rules, last price, day stats, book
 * and tape — as one wire object. Shared by `GET /v1/exchange/market` and the
 * market ticker, so a pushed snapshot and a polled one are the same shape by
 * construction: the client can drop either into the same cache entry.
 */
export async function buildMarketSnapshot(
  pool: pg.Pool,
  symbol: string,
  depth: number,
  tapeLimit: number,
) {
  const [market, stats, book, tape] = await Promise.all([
    getMarket(pool, symbol),
    getDayStats(pool, symbol),
    getBook(pool, symbol, depth),
    getTape(pool, symbol, tapeLimit),
  ]);
  if (!market) return null;

  const cashOrNull = (value: bigint | null) => (value === null ? null : formatCash(value));
  const level = (l: { price: bigint; quantity: bigint; orders: number }) => ({
    price: formatCash(l.price),
    quantity: formatQuantity(l.quantity),
    orders: l.orders,
  });

  return {
    market: {
      symbol: market.symbol,
      displayName: market.displayName,
      tickSize: formatCash(market.tickSize),
      lotSize: formatQuantity(market.lotSize),
      minPrice: formatCash(market.minPrice),
      maxPrice: formatCash(market.maxPrice),
      openingPrice: formatCash(market.openingPrice),
      lastPrice: formatCash(market.lastPrice),
      lastTradeAt: market.lastTradeAt,
    },
    stats: {
      open: cashOrNull(stats.open),
      high: cashOrNull(stats.high),
      low: cashOrNull(stats.low),
      volume: formatQuantity(stats.volume),
      trades: stats.trades,
    },
    book: { bids: book.bids.map(level), asks: book.asks.map(level) },
    tape: tape.map((t) => ({
      id: t.id.toString(),
      price: formatCash(t.price),
      quantity: formatQuantity(t.quantity),
      takerSide: t.takerSide,
      createdAt: t.createdAt,
    })),
  };
}

export type MarketSnapshot = NonNullable<Awaited<ReturnType<typeof buildMarketSnapshot>>>;
