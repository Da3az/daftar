/* Wire shapes for the daftar exchange API.
   Fields marked [CHANGE] depart from the reference contract; each is recorded in CONTRACT-CHANGES.md. */

/** Exact decimal string, exactly 2 fractional digits. Never parse to number. */
export type CashAmount = string;
/** Exact decimal string, exactly 8 fractional digits. Never parse to number. */
export type Quantity = string;
/** ISO 8601 UTC timestamp. */
export type Timestamp = string;

export type Side = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';
export type OrderStatus = 'open' | 'filled' | 'cancelled';
export type ParticipantKind = 'guest' | 'bot';
export type Liquidity = 'maker' | 'taker';
export type CandleInterval = '1m' | '5m' | '1h';

// -------------------------------------------------------------- market data
export interface MarketInfo {
  symbol: string;
  displayName: string;
  tickSize: CashAmount;
  lotSize: Quantity;
  minPrice: CashAmount;
  maxPrice: CashAmount;
  openingPrice: CashAmount;
  /** Last traded price, or the opening price until one exists. */
  lastPrice: CashAmount;
  lastTradeAt: Timestamp | null;
}

export interface DayStats {
  /** null when nothing traded in the window. */
  open: CashAmount | null;
  high: CashAmount | null;
  low: CashAmount | null;
  volume: Quantity;
  trades: number;
}

export interface BookLevel {
  price: CashAmount;
  /** Total resting at this price. */
  quantity: Quantity;
  /** How many orders make it up. */
  orders: number;
}

export interface TapeTrade {
  /** Numeric string. */
  id: string;
  price: CashAmount;
  quantity: Quantity;
  takerSide: Side;
  createdAt: Timestamp;
}

export interface MarketSnapshot {
  market: MarketInfo;
  stats: DayStats;
  /** bids: best (highest) first. asks: best (lowest) first. */
  book: { bids: BookLevel[]; asks: BookLevel[] };
  /** Newest first. */
  tape: TapeTrade[];
}

export interface Candle {
  /** Bucket start, Unix seconds. */
  time: number;
  open: CashAmount;
  high: CashAmount;
  low: CashAmount;
  close: CashAmount;
  volume: Quantity;
}

export interface CandlesResponse {
  interval: CandleInterval;
  intervalSeconds: number;
  /** Oldest first. Buckets with no trade are absent. */
  candles: Candle[];
}

// ------------------------------------------------------------- the session
export interface Participant {
  displayName: string;
  kind: ParticipantKind;
  createdAt: Timestamp;
}

export interface Balances {
  cash: CashAmount;
  /** Total minus cash reserved by open buy orders. */
  cashAvailable: CashAmount;
  asset: Quantity;
  /** Total minus coin reserved by open sell orders. */
  assetAvailable: Quantity;
}

/** [CHANGE] The parts of netContributed, so the UI can show a sum that adds up. */
export interface Contributions {
  openingCredit: CashAmount;
  deposits: CashAmount;
  transfersIn: CashAmount;
  withdrawals: CashAmount;
  transfersOut: CashAmount;
}

export interface Me {
  participant: Participant;
  symbol: string;
  startingCash: CashAmount;
  /** Public 10-char hex code another guest uses to send this one cash. */
  handle: string;
  /** openingCredit + deposits + transfersIn − withdrawals − transfersOut. */
  netContributed: CashAmount;
  /** [CHANGE] */
  contributions: Contributions;
  /** Events committed with this account's money, not yet in its feed. */
  pendingEvents: number;
  balances: Balances;
  /** Up to 100, newest first, createdAt/updatedAt present. */
  openOrders: ExchangeOrder[];
}

// ----------------------------------------------------------------- orders
/** `self_trade`: the server cancels your own waiting order when a newer one of yours would cross it. */
export type CancelReason = 'user' | 'insufficient_funds' | 'no_liquidity' | 'self_trade';

export interface ExchangeOrder {
  clientOrderId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  /** null for a market order. */
  limitPrice: CashAmount | null;
  quantity: Quantity;
  /** 0 ≤ filled ≤ quantity. */
  filledQuantity: Quantity;
  status: OrderStatus;
  /** A CancelReason when cancelled; treated as an open set. */
  cancelReason: string | null;
  /** Present on list endpoints; absent in a place-order response. */
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

/** One leg of one trade, as this order saw it. */
export interface Fill {
  /** The RESTING order's limit price. */
  price: CashAmount;
  quantity: Quantity;
  /** price × quantity. */
  notional: CashAmount;
}

export interface OwnFill extends Fill {
  /** Numeric string. */
  tradeId: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  liquidity: Liquidity;
  createdAt: Timestamp;
  /** [CHANGE] The other side's display name, e.g. "Kestrel". */
  counterparty: string | null;
}

export type PlaceOrderRequest =
  | { type: 'limit'; clientOrderId: string; side: Side; quantity: Quantity; limitPrice: CashAmount }
  | { type: 'market'; clientOrderId: string; side: Side; quantity: Quantity };

export interface PlaceOrderResult {
  order: ExchangeOrder;
  fills: Fill[];
  /** Client-side: true when the server answered 200 (replay of an identical request) rather than 201. */
  replayed: boolean;
}

// ------------------------------------------------------------------- cash
export interface DepositDelivery {
  /** Which of the requested deliveries, from 1. */
  delivery: number;
  /** 0 for the first attempt. */
  retry: number;
  /** HTTP status the webhook endpoint returned. */
  status: number;
  /** 'processed' | 'duplicate' | 'in_progress' | a rejection code. */
  outcome: string;
  /** [CHANGE] Milliseconds from dispatch to the webhook's answer. */
  latencyMs: number;
}

export interface DepositResult {
  depositId: string;
  amount: CashAmount;
  /** true if exactly one delivery was processed. */
  credited: boolean;
  deliveries: DepositDelivery[];
  summary: { processed: number; duplicates: number; inProgress: number; rejected: number };
  /** [CHANGE] The account's cash after it, as MovementResult has. */
  cashBalance: CashAmount;
}

export interface MovementResult {
  status: 'completed';
  amount: CashAmount;
  cashBalance: CashAmount;
  /** [CHANGE] Echo of the client id and the commit time, for the receipt. */
  clientId: string;
  occurredAt: Timestamp;
}

/** [CHANGE] Answer of the handle lookup used before a transfer. */
export interface Recipient {
  handle: string;
  displayName: string;
}

// --------------------------------------------------------------- activity
/** [CHANGE] One line of the balanced ledger transaction behind an event. */
export interface LedgerEntry {
  /** Human account label, e.g. "Your cash", "Kestrel · cash", "Payment provider · clearing". */
  account: string;
  direction: 'debit' | 'credit';
  /** Exact decimal string in `unit`. */
  amount: string;
  /** "USD" or the market symbol. */
  unit: string;
}

export interface ActivityEvent {
  /** Numeric string. */
  id: string;
  /** 'trade.buy' | 'trade.sell' | 'deposit.credited' | 'withdrawal.completed' |
      'transfer.sent' | 'transfer.received' — an open set. */
  type: string;
  /** When the money moved. */
  occurredAt: Timestamp;
  /** When the worker delivered it; the gap is lag. */
  publishedAt: Timestamp;
  amount: CashAmount | null;
  symbol: string | null;
  side: Side | null;
  liquidity: Liquidity | null;
  price: CashAmount | null;
  quantity: Quantity | null;
  /** A handle or display name, for transfers and trades. */
  counterparty: string | null;
  /** [CHANGE] The client-chosen id of the order or movement, or the deposit id. */
  reference: string | null;
  /** [CHANGE] The double-entry lines. Per unit, debits equal credits. */
  entries: LedgerEntry[];
}

export interface ActivityResponse {
  /** Events committed with this account's money and not yet in this list. */
  pending: number;
  /** Newest first. */
  events: ActivityEvent[];
}

// ----------------------------------------------------------------- errors
export interface ApiErrorBody {
  error: string;
  message: string;
  /** Only on insufficient_funds: "USD" or the market symbol. */
  unit?: string;
  available?: string;
  required?: string;
  /** Only on validation_failed. */
  issues?: { path: string; message: string }[];
  /** [CHANGE] On 429: seconds until the limit window frees a slot (mirrors Retry-After). */
  retryAfterSeconds?: number;
}
