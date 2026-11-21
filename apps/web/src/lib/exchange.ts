import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiRequest } from '@/lib/api';
import { CASH_SCALE, QUANTITY_SCALE, fromMinor, toMinor } from '@/lib/money';

/**
 * # The exchange client
 *
 * Same rule as `api.ts`: amounts are exact decimal strings from the wire to the
 * DOM, and any arithmetic happens in `BigInt` on minor units.
 *
 * ## No account id, anywhere
 *
 * The legacy client passes the account it is looking at with every request.
 * This one never does. The session is an HttpOnly cookie the server set, sent
 * automatically on these same-origin requests, and unreadable from this code —
 * which is the point of it.
 *
 * ## Polling, not a socket
 *
 * The book is refetched once a second. A websocket would be fresher by a few
 * hundred milliseconds and would need a fan-out path, reconnection, and a
 * story for two API instances; at one market and a dozen bots, a one-second
 * poll of one indexed snapshot is the whole problem solved.
 */

export type Side = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';

export interface MarketInfo {
  symbol: string;
  displayName: string;
  tickSize: string;
  lotSize: string;
  minPrice: string;
  maxPrice: string;
  openingPrice: string;
  lastPrice: string;
  lastTradeAt: string | null;
}

export interface BookLevel {
  price: string;
  quantity: string;
  orders: number;
}

export interface TapeTrade {
  id: string;
  price: string;
  quantity: string;
  takerSide: Side;
  createdAt: string;
}

export interface MarketSnapshot {
  market: MarketInfo;
  stats: {
    open: string | null;
    high: string | null;
    low: string | null;
    volume: string;
    trades: number;
  };
  book: { bids: BookLevel[]; asks: BookLevel[] };
  tape: TapeTrade[];
}

export interface ExchangeOrder {
  clientOrderId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  limitPrice: string | null;
  quantity: string;
  filledQuantity: string;
  status: 'open' | 'filled' | 'cancelled';
  cancelReason: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Me {
  participant: { displayName: string; kind: 'guest' | 'bot'; createdAt: string };
  symbol: string;
  startingCash: string;
  /** Public code another guest uses to send this one cash. Safe to show. */
  handle: string;
  /** Opening credit plus deposits and transfers in, less withdrawals and transfers out. */
  netContributed: string;
  /** Events committed with this account's money that the feed has not shown yet. */
  pendingEvents: number;
  balances: { cash: string; cashAvailable: string; asset: string; assetAvailable: string };
  openOrders: ExchangeOrder[];
}

export interface Fill {
  tradeId: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  liquidity: 'maker' | 'taker';
  price: string;
  quantity: string;
  notional: string;
  createdAt: string;
}

export interface Candle {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export type CandleInterval = '1m' | '5m' | '1h';

export const getMarketSnapshot = (): Promise<MarketSnapshot> =>
  apiRequest('/v1/exchange/market?depth=14&tape=40');

export const getCandles = (interval: CandleInterval): Promise<{ candles: Candle[] }> =>
  apiRequest(`/v1/exchange/candles?interval=${interval}&limit=240`);

/**
 * The session's account, or `null` when there is no session.
 *
 * A 401 here is an answer, not a failure: it is how a first-time visitor's
 * state is spelled. Turning it into `null` keeps it out of the error path, so
 * the page renders "enter as guest" rather than an error note.
 */
export async function getMe(): Promise<Me | null> {
  try {
    return await apiRequest<Me>('/v1/exchange/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export const enterAsGuest = (): Promise<unknown> =>
  apiRequest('/v1/exchange/guest', { method: 'POST' });

export const leave = (): Promise<unknown> => apiRequest('/v1/exchange/logout', { method: 'POST' });

export interface PlaceOrderInput {
  side: Side;
  type: OrderType;
  quantity: string;
  limitPrice?: string;
}

export const placeOrder = (
  input: PlaceOrderInput,
): Promise<{
  order: ExchangeOrder;
  fills: { price: string; quantity: string; notional: string }[];
}> => {
  /*
   * Generated per submission, and sent twice: as the order's own id, which a
   * UNIQUE index scoped to this guest turns into "one order" on a double
   * click, and as the `Idempotency-Key`, which lets a retry of this same
   * request get the original answer back rather than a 409.
   */
  const clientOrderId = `web-${crypto.randomUUID()}`;

  return apiRequest('/v1/exchange/orders', {
    method: 'POST',
    headers: { 'idempotency-key': clientOrderId },
    body: {
      clientOrderId,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      // Absent, not undefined, for a market order: the server's schema is
      // strict and rejects a market order that carries a price.
      ...(input.type === 'limit' ? { limitPrice: input.limitPrice } : {}),
    },
  });
};

export const cancelOrder = (clientOrderId: string): Promise<unknown> =>
  apiRequest(`/v1/exchange/orders/${encodeURIComponent(clientOrderId)}`, { method: 'DELETE' });

export const getOrders = (): Promise<{ orders: ExchangeOrder[] }> =>
  apiRequest('/v1/exchange/orders?status=all&limit=100');

export const getFills = (): Promise<{ fills: Fill[] }> =>
  apiRequest('/v1/exchange/fills?limit=100');

/* --------------------------------------------------------------------- cash */

export interface DepositDelivery {
  /** Which of the requested deliveries, from 1. */
  delivery: number;
  /** 0 for the first attempt; the provider re-delivers after a 409. */
  retry: number;
  status: number;
  /** `processed`, `duplicate`, `in_progress`, or a rejection code. */
  outcome: string;
}

export interface DepositResult {
  depositId: string;
  amount: string;
  credited: boolean;
  deliveries: DepositDelivery[];
  summary: { processed: number; duplicates: number; inProgress: number; rejected: number };
}

/** `deliveries` is how many times the simulated provider sends the one event. */
export const deposit = (input: { amount: string; deliveries: number }): Promise<DepositResult> =>
  apiRequest('/v1/exchange/deposits', { method: 'POST', body: input });

export interface MovementResult {
  status: 'completed';
  amount: string;
  cashBalance: string;
}

export const withdraw = (amount: string): Promise<MovementResult> =>
  apiRequest('/v1/exchange/withdrawals', {
    method: 'POST',
    body: { clientId: `web-${crypto.randomUUID()}`, amount },
  });

export const sendTransfer = (input: {
  amount: string;
  toHandle: string;
}): Promise<MovementResult> =>
  apiRequest('/v1/exchange/transfers', {
    method: 'POST',
    body: { clientId: `web-${crypto.randomUUID()}`, ...input },
  });

export interface ActivityEvent {
  id: string;
  /** e.g. `trade.buy`, `deposit.credited`, `transfer.received`. */
  type: string;
  occurredAt: string;
  publishedAt: string;
  amount: string | null;
  symbol: string | null;
  side: Side | null;
  liquidity: 'maker' | 'taker' | null;
  price: string | null;
  quantity: string | null;
  counterparty: string | null;
}

export const getActivity = (): Promise<{ pending: number; events: ActivityEvent[] }> =>
  apiRequest('/v1/exchange/activity?limit=50');

/* -------------------------------------------------------------------- hooks */

const KEYS = {
  market: ['exchange', 'market'] as const,
  me: ['exchange', 'me'] as const,
};

export const useMarketSnapshot = () =>
  useQuery({
    queryKey: KEYS.market,
    queryFn: getMarketSnapshot,
    staleTime: 0,
    refetchInterval: 1_000,
  });

export const useMe = () =>
  useQuery({
    queryKey: KEYS.me,
    queryFn: getMe,
    staleTime: 0,
    // Only a guest has anything that changes. A visitor without a session is
    // not polled at all — there is nothing for the answer to become.
    refetchInterval: (query) => (query.state.data ? 2_000 : false),
    retry: false,
  });

/** Everything under `['exchange']` — after an order, all of it is stale. */
export function useRefreshExchange(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['exchange'] });
}

/* ------------------------------------------------------------------ display */

/**
 * `12.50000000` → `12.50`. Trailing zeros beyond two places are dropped.
 *
 * The legacy pages keep all eight digits because there the scale is the point.
 * Here the lot is a hundredth of a coin, so six of the eight are always zero
 * and a book column of them is noise. Digits that are *not* zero are kept —
 * this trims, it never rounds.
 */
export function trimQuantity(decimal: string): string {
  const [whole = '0', fraction = ''] = decimal.split('.');
  const kept = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${kept}`;
}

/**
 * Signed percentage change from `from` to `to`, to two places: `+1.24%`.
 *
 * In `BigInt` basis points. `null` when either side is missing or `from` is
 * zero, rather than a `NaN%` in the header.
 */
export function percentChange(from: string | null, to: string | null): string | null {
  if (from === null || to === null) return null;

  const a = toMinor(from, CASH_SCALE);
  const b = toMinor(to, CASH_SCALE);
  if (a === null || b === null || a === 0n) return null;

  const basisPoints = ((b - a) * 10_000n) / a;
  const sign = basisPoints > 0n ? '+' : basisPoints < 0n ? '-' : '';
  const magnitude = basisPoints < 0n ? -basisPoints : basisPoints;

  return `${sign}${fromMinor(magnitude, 2)}%`;
}

/** `quantity × price`, truncated, as a cash decimal. `null` if either is malformed. */
export function valueOf(quantity: string, price: string): string | null {
  const q = toMinor(quantity, QUANTITY_SCALE);
  const p = toMinor(price, CASH_SCALE);
  if (q === null || p === null) return null;
  return fromMinor((q * p) / 100_000_000n, CASH_SCALE);
}

/**
 * The largest quantity `cash` buys at `price`, as a whole number of lots,
 * scaled by `percent`.
 */
export function affordableQuantity(
  cash: string,
  price: string,
  lotSize: string,
  percent: number,
): string | null {
  const c = toMinor(cash, CASH_SCALE);
  const p = toMinor(price, CASH_SCALE);
  const lot = toMinor(lotSize, QUANTITY_SCALE);
  if (c === null || p === null || lot === null || p <= 0n || lot <= 0n) return null;

  let quantity = (((c * 100_000_000n) / p) * BigInt(percent)) / 100n;
  quantity -= quantity % lot;
  return quantity > 0n ? fromMinor(quantity, QUANTITY_SCALE) : null;
}

/** `percent` of `quantity`, floored to a whole number of lots. */
export function portionOf(quantity: string, lotSize: string, percent: number): string | null {
  const q = toMinor(quantity, QUANTITY_SCALE);
  const lot = toMinor(lotSize, QUANTITY_SCALE);
  if (q === null || lot === null || lot <= 0n) return null;

  let portion = (q * BigInt(percent)) / 100n;
  portion -= portion % lot;
  return portion > 0n ? fromMinor(portion, QUANTITY_SCALE) : null;
}

/** `13:14:30` in UTC, for the tape. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(11, 19);
}
