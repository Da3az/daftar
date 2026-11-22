import { ApiError, NetworkError, type ApiClient } from './client';
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
  NotificationsResponse,
  Cadence,
  RecurringPlan,
} from './types';

const BASE = '/v1/exchange';

/** Longer than any honest answer, including a 5-delivery deposit with retries. */
const TIMEOUT_MS = 15_000;

type Query = Record<string, string | number | undefined>;

interface Request {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Answer {
  status: number;
  body: unknown;
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { error?: unknown }).error === 'string' &&
  typeof (value as { message?: unknown }).message === 'string';

/**
 * `Retry-After` is either delta-seconds or an HTTP date (RFC 9110 §10.2.3).
 * Returns whole seconds, at least 1, or undefined when absent or unreadable.
 */
function retryAfterSeconds(header: string | null, now = Date.now()): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Math.max(1, Number.parseInt(trimmed, 10));
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(1, Math.ceil((at - now) / 1_000));
}

/**
 * The fetch-backed ApiClient. Same-origin only: in development Vite proxies
 * `/v1` to the API, in production the API serves the static build, so the
 * session cookie (HttpOnly) rides along and no account id is ever handled here.
 */
export class HttpApiClient implements ApiClient {
  readonly #base: string;

  constructor(base: string = BASE) {
    this.#base = base;
  }

  async #send(method: string, path: string, request: Request = {}): Promise<Answer> {
    const url = new URL(this.#base + path, window.location.origin);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { accept: 'application/json', ...request.headers };
    // Only with a body: Fastify refuses an empty body labelled as JSON.
    if (request.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        credentials: 'same-origin',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      throw new NetworkError(
        timedOut ? 'The server took too long to answer.' : 'The server could not be reached.',
      );
    }

    let body: unknown;
    let json = false;
    try {
      const text = await response.text();
      if (text !== '') {
        body = JSON.parse(text) as unknown;
        json = true;
      }
    } catch {
      body = undefined;
    }

    if (response.ok) return { status: response.status, body };

    // A proxy or gateway answering for an API that is down: not the API's refusal.
    if (!json && [500, 502, 503, 504].includes(response.status)) throw new NetworkError();

    const errorBody: ApiErrorBody = isErrorBody(body)
      ? body
      : {
          error: `http_${response.status}`,
          message: response.statusText || `The server answered ${response.status}.`,
        };
    if (response.status === 429 && errorBody.retryAfterSeconds === undefined) {
      const seconds = retryAfterSeconds(response.headers.get('retry-after'));
      if (seconds !== undefined) errorBody.retryAfterSeconds = seconds;
    }
    throw new ApiError(response.status, errorBody);
  }

  async enterAsGuest(): Promise<{
    participant: Participant;
    startingCash: CashAmount;
    created: boolean;
  }> {
    const { status, body } = await this.#send('POST', '/guest');
    return {
      ...(body as { participant: Participant; startingCash: CashAmount }),
      created: status === 201,
    };
  }

  async logout(): Promise<void> {
    await this.#send('POST', '/logout');
  }

  async getMe(): Promise<Me | null> {
    try {
      return (await this.#send('GET', '/me')).body as Me;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  }

  async getMarket(opts: { depth?: number; tape?: number } = {}): Promise<MarketSnapshot> {
    return (await this.#send('GET', '/market', { query: { depth: opts.depth, tape: opts.tape } }))
      .body as MarketSnapshot;
  }

  async getCandles(interval: CandleInterval, limit?: number): Promise<CandlesResponse> {
    return (await this.#send('GET', '/candles', { query: { interval, limit } }))
      .body as CandlesResponse;
  }

  async placeOrder(request: PlaceOrderRequest, idempotencyKey?: string): Promise<PlaceOrderResult> {
    const { status, body } = await this.#send('POST', '/orders', {
      body: request,
      ...(idempotencyKey === undefined ? {} : { headers: { 'idempotency-key': idempotencyKey } }),
    });
    return { ...(body as Omit<PlaceOrderResult, 'replayed'>), replayed: status === 200 };
  }

  async listOrders(
    opts: { status?: 'open' | 'all'; limit?: number } = {},
  ): Promise<{ orders: ExchangeOrder[] }> {
    return (
      await this.#send('GET', '/orders', { query: { status: opts.status, limit: opts.limit } })
    ).body as { orders: ExchangeOrder[] };
  }

  async cancelOrder(clientOrderId: string): Promise<{ status: 'cancelled' }> {
    return (await this.#send('DELETE', `/orders/${encodeURIComponent(clientOrderId)}`)).body as {
      status: 'cancelled';
    };
  }

  async listFills(limit?: number): Promise<{ fills: OwnFill[] }> {
    return (await this.#send('GET', '/fills', { query: { limit } })).body as { fills: OwnFill[] };
  }

  async deposit(request: { amount: CashAmount; deliveries?: number }): Promise<DepositResult> {
    return (await this.#send('POST', '/deposits', { body: request })).body as DepositResult;
  }

  async withdraw(request: { clientId: string; amount: CashAmount }): Promise<MovementResult> {
    return (await this.#send('POST', '/withdrawals', { body: request })).body as MovementResult;
  }

  async transfer(request: {
    clientId: string;
    amount: CashAmount;
    toHandle: string;
  }): Promise<MovementResult> {
    return (await this.#send('POST', '/transfers', { body: request })).body as MovementResult;
  }

  async lookupRecipient(handle: string): Promise<Recipient> {
    return (await this.#send('GET', `/recipients/${encodeURIComponent(handle)}`)).body as Recipient;
  }

  async getActivity(limit?: number): Promise<ActivityResponse> {
    return (await this.#send('GET', '/activity', { query: { limit } })).body as ActivityResponse;
  }

  async getPosition(): Promise<Position> {
    return (await this.#send('GET', '/position')).body as Position;
  }

  async getEquity(range: EquityRange): Promise<EquityResponse> {
    return (await this.#send('GET', '/equity', { query: { range } })).body as EquityResponse;
  }

  async listWithdrawals(limit?: number): Promise<{ withdrawals: Withdrawal[] }> {
    return (await this.#send('GET', '/withdrawals', { query: { limit } })).body as {
      withdrawals: Withdrawal[];
    };
  }

  async getNotifications(limit?: number): Promise<NotificationsResponse> {
    return (await this.#send('GET', '/notifications', { query: { limit } }))
      .body as NotificationsResponse;
  }

  async markNotificationsRead(upTo: string): Promise<{ marked: number }> {
    return (await this.#send('POST', '/notifications/read', { body: { upTo } })).body as {
      marked: number;
    };
  }

  async listRecurring(): Promise<{ plans: RecurringPlan[] }> {
    return (await this.#send('GET', '/recurring')).body as { plans: RecurringPlan[] };
  }

  async createRecurring(request: {
    amount: CashAmount;
    cadence: Cadence;
  }): Promise<{ plan: RecurringPlan }> {
    return (await this.#send('POST', '/recurring', { body: request })).body as {
      plan: RecurringPlan;
    };
  }

  async setRecurringActive(id: string, active: boolean): Promise<{ plan: RecurringPlan }> {
    return (
      await this.#send(
        'POST',
        `/recurring/${encodeURIComponent(id)}/${active ? 'resume' : 'pause'}`,
      )
    ).body as { plan: RecurringPlan };
  }

  async deleteRecurring(id: string): Promise<void> {
    await this.#send('DELETE', `/recurring/${encodeURIComponent(id)}`);
  }
}
