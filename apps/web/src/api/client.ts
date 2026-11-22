import type {
  ActivityResponse,
  ApiErrorBody,
  EquityRange,
  EquityResponse,
  Position,
  CandleInterval,
  CandlesResponse,
  CashAmount,
  DepositResult,
  ExchangeOrder,
  MarketSnapshot,
  Me,
  MovementResult,
  OwnFill,
  Participant,
  PlaceOrderRequest,
  PlaceOrderResult,
  Recipient,
  Withdrawal,
} from './types';

/** Every non-2xx answer. `status` decides rate limiting (429); `code` decides everything else. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
  get code(): string {
    return this.body.error;
  }
  get rateLimited(): boolean {
    return this.status === 429 && this.body.error !== 'deposit_limit';
  }
}

/** Thrown when the request never got an answer (network down, timeout). */
export class NetworkError extends Error {
  constructor(message = 'The server could not be reached.') {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * The only way components reach data. One real implementation (fetch) will replace MockApiClient.
 * Every method rejects with ApiError or NetworkError. The session is an HttpOnly cookie:
 * no method takes or returns an account id.
 */
export interface ApiClient {
  /** POST /v1/exchange/guest — 201 created, 200 already had a session. 429: 20 an hour per address. */
  enterAsGuest(): Promise<{ participant: Participant; startingCash: CashAmount; created: boolean }>;
  /** POST /v1/exchange/logout — 204. */
  logout(): Promise<void>;
  /** GET /v1/exchange/me — resolves null on 401 not_a_guest: "no account on this browser" is an answer. */
  getMe(): Promise<Me | null>;
  /** GET /v1/exchange/market — public. */
  getMarket(opts?: { depth?: number; tape?: number }): Promise<MarketSnapshot>;
  /** GET /v1/exchange/candles — public. */
  getCandles(interval: CandleInterval, limit?: number): Promise<CandlesResponse>;
  /**
   * POST /v1/exchange/orders. Errors: 400 validation_failed (zero, negative or over-precise amounts land here) ·
   * 401 not_a_guest · 404 unknown_market · 409 duplicate_order ·
   * 409 request_in_progress · 422 idempotency_key_reused · 422 invalid_quantity · 422 invalid_price ·
   * 422 insufficient_funds (unit, available, required) · 422 too_many_open_orders · 422 no_liquidity ·
   * 429 (120 orders a minute; cancels count separately) · 500 internal_error.
   */
  placeOrder(request: PlaceOrderRequest, idempotencyKey?: string): Promise<PlaceOrderResult>;
  /** GET /v1/exchange/orders — newest first. */
  listOrders(opts?: {
    status?: 'open' | 'all';
    limit?: number;
  }): Promise<{ orders: ExchangeOrder[] }>;
  /** DELETE /v1/exchange/orders/{id}. Errors: 400 validation_failed · 401 not_a_guest · 404 unknown_order ·
      409 order_not_open · 429 (120 cancels a minute). */
  cancelOrder(clientOrderId: string): Promise<{ status: 'cancelled' }>;
  /** GET /v1/exchange/fills — newest first. */
  listFills(limit?: number): Promise<{ fills: OwnFill[] }>;
  /** POST /v1/exchange/deposits. Errors: 400 validation_failed · 401 not_a_guest · 422 amount_too_large ·
      429 deposit_limit · 429 (30 deposits a minute). */
  deposit(request: { amount: CashAmount; deliveries?: number }): Promise<DepositResult>;
  /** POST /v1/exchange/withdrawals. Errors: 400 validation_failed · 401 not_a_guest · 409 duplicate_movement ·
      422 amount_too_large · 422 insufficient_funds · 429 (30 withdrawals a minute). */
  withdraw(request: { clientId: string; amount: CashAmount }): Promise<MovementResult>;
  /** POST /v1/exchange/transfers. Errors: 400 validation_failed · 401 not_a_guest · 404 unknown_recipient ·
      409 duplicate_movement · 422 amount_too_large · 422 self_transfer · 422 insufficient_funds ·
      429 (30 transfers a minute). */
  transfer(request: {
    clientId: string;
    amount: CashAmount;
    toHandle: string;
  }): Promise<MovementResult>;
  /** [CHANGE] GET /v1/exchange/recipients/{handle}. Errors: 400 validation_failed · 401 not_a_guest ·
      404 unknown_recipient · 422 self_transfer · 429 (30 lookups a minute, its own limit). */
  lookupRecipient(handle: string): Promise<Recipient>;
  /** GET /v1/exchange/activity — newest first. */
  getActivity(limit?: number): Promise<ActivityResponse>;
  /** GET /v1/exchange/position — average entry and P&L, from the positions projection. */
  getPosition(): Promise<Position>;
  /** GET /v1/exchange/equity — snapshot series; missed slots are absent, not interpolated. */
  getEquity(range: EquityRange): Promise<EquityResponse>;
  /** GET /v1/exchange/withdrawals — newest first, each with its state history. */
  listWithdrawals(limit?: number): Promise<{ withdrawals: Withdrawal[] }>;
}
