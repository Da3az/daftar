import type { BookLevel, MarketInfo, OrderType, Side } from '@/api/types';
import {
  formatUnits,
  notional,
  parseCash,
  parseQty,
  parseUnits,
  showCash,
  showQty,
} from '@/lib/money';
import { MAX_ORDER_QTY_UNITS } from '@/lib/rules';

export interface TicketValues {
  side: Side;
  type: OrderType;
  price: string;
  quantity: string;
}

export interface Rules {
  tick: bigint;
  lot: bigint;
  min: bigint;
  max: bigint;
}

export function rulesOf(market: MarketInfo | undefined): Rules {
  return {
    tick: parseCash(market?.tickSize) ?? 1n,
    lot: parseQty(market?.lotSize) ?? 1_000_000n,
    min: parseCash(market?.minPrice) ?? 100n,
    max: parseCash(market?.maxPrice) ?? 1_000_000n,
  };
}

export interface Checked {
  priceCents: bigint | null;
  qtyUnits: bigint | null;
  priceIssue: string | null;
  quantityIssue: string | null;
}

/** A courtesy check that decides nothing: the server re-checks and its answer wins. */
export function check(values: TicketValues, rules: Rules): Checked {
  let priceCents: bigint | null = null;
  let priceIssue: string | null = null;
  if (values.type === 'limit' && values.price.trim() !== '') {
    priceCents = parseUnits(values.price.trim(), 2);
    if (priceCents === null) priceIssue = 'Enter a price with at most two decimals, like 25.03.';
    else if (priceCents % rules.tick !== 0n)
      priceIssue = `Prices move in steps of ${showCash(rules.tick)}.`;
    else if (priceCents < rules.min || priceCents > rules.max)
      priceIssue = `Price must be between ${showCash(rules.min)} and ${showCash(rules.max)}.`;
    if (priceIssue) priceCents = null;
  }
  let qtyUnits: bigint | null = null;
  let quantityIssue: string | null = null;
  if (values.quantity.trim() !== '') {
    qtyUnits = parseUnits(values.quantity.trim(), 8);
    if (qtyUnits === null) quantityIssue = 'Enter a number of coins, like 10 or 0.25.';
    else if (qtyUnits <= 0n) quantityIssue = 'Quantity must be more than zero.';
    else if (qtyUnits % rules.lot !== 0n)
      quantityIssue = `Coins trade in steps of ${showQty(rules.lot)}.`;
    else if (qtyUnits > MAX_ORDER_QTY_UNITS)
      quantityIssue = `One order can be at most ${showQty(MAX_ORDER_QTY_UNITS, 0)} coins.`;
    if (quantityIssue) qtyUnits = null;
  }
  return { priceCents, qtyUnits, priceIssue, quantityIssue };
}

export interface Estimate {
  /** Fills immediately against the visible book. */
  fillUnits: bigint;
  fillCents: bigint;
  /** Limit only: waits in the book. */
  restUnits: bigint;
  /** Market only: more than the visible book holds; this part would be cancelled. */
  shortUnits: bigint;
  /** Cash that leaves (buy) or arrives (sell) if it all happens as estimated. */
  totalCents: bigint;
  /** Average fill price to four places, or null when nothing fills. */
  average: string | null;
  /** True when the figure cannot change: a limit order that fills nothing now. */
  exact: boolean;
  /** The worst price swept. */
  lastPrice: string | null;
}

/** Walk the visible opposite side of the book. Estimates only: the book moves, and only 15 levels are visible. */
export function estimate(
  side: Side,
  type: OrderType,
  priceCents: bigint | null,
  qtyUnits: bigint,
  levels: BookLevel[],
): Estimate {
  let left = qtyUnits;
  let fillUnits = 0n;
  let fillCents = 0n;
  let lastPrice: string | null = null;
  for (const level of levels) {
    if (left <= 0n) break;
    const price = parseCash(level.price);
    const available = parseQty(level.quantity);
    if (price === null || available === null) continue;
    if (
      type === 'limit' &&
      priceCents !== null &&
      (side === 'buy' ? price > priceCents : price < priceCents)
    )
      break;
    const take = available < left ? available : left;
    fillUnits += take;
    fillCents += notional(price, take);
    left -= take;
    lastPrice = level.price;
  }
  const restUnits = type === 'limit' ? left : 0n;
  const shortUnits = type === 'market' ? left : 0n;
  const restCents = type === 'limit' && priceCents !== null ? notional(priceCents, restUnits) : 0n;
  const average =
    fillUnits > 0n ? formatUnits((fillCents * 100_000_000n * 100n) / fillUnits, 4) : null;
  return {
    fillUnits,
    fillCents,
    restUnits,
    shortUnits,
    totalCents: fillCents + restCents,
    average,
    exact: type === 'limit' && fillUnits === 0n,
    lastPrice,
  };
}

/** Middle of the book and the gap between its sides. null parts when a side is empty. */
export function spreadOf(
  bids: BookLevel[],
  asks: BookLevel[],
): { middle: string | null; gap: string | null; gapPercent: string | null } {
  const bid = parseCash(bids[0]?.price);
  const ask = parseCash(asks[0]?.price);
  if (bid === null || ask === null || bid <= 0n)
    return { middle: null, gap: null, gapPercent: null };
  const sum = bid + ask;
  const middle = sum % 2n === 0n ? showCash(sum / 2n) : formatUnits(sum * 5n, 3);
  const gap = ask - bid;
  const hundredths = (gap * 2n * 10_000n + sum / 2n) / sum; // percent × 100
  return { middle, gap: showCash(gap), gapPercent: `${formatUnits(hundredths, 2)}%` };
}
