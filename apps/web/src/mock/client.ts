import { ApiError, NetworkError, type ApiClient } from '@/api/client';
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
} from '@/api/types';
import { formatCash, parseCash } from '@/lib/money';
import { EquityRecorder, positionFromFills } from './projections';
import { devSwitches, type ForcedCashError, type ForcedOrderError } from './devSwitches';
import { MAX_DEPOSIT, type EngineResult, type MatchingEngine, type ParticipantId } from './engine';

const SESSION_KEY = 'daftar.mock.session';
/** Same shape the server accepts: 8–64 characters, starting with a letter or digit. */
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;
const HANDLE = /^[0-9a-f]{10}$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const IDEMPOTENCY_KEEP = 500;

type Issue = { path: string; message: string };

interface StoredSession {
  token: string;
  displayName: string;
  handle: string;
  createdAt: number;
  /** The seeded demo guest is rebuilt by resetMock rather than re-created here. */
  demo: boolean;
}

type IdempotencyRecord =
  | { signature: string; state: 'in_flight' }
  | { signature: string; state: 'done'; result: PlaceOrderResult }
  | { signature: string; state: 'failed'; error: ApiError };

class SlidingWindow {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  private live(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    this.hits.set(key, list);
    return list;
  }

  /** Seconds until a slot frees, or null when there is room. */
  blocked(key: string, now: number): number | null {
    const list = this.live(key, now);
    return list.length < this.limit ? null : this.secondsUntilSlot(list, now);
  }

  record(key: string, now: number): void {
    this.live(key, now).push(now);
  }

  /** What a 429 would say right now, for forced errors. */
  retryAfter(key: string, now: number): number {
    return this.secondsUntilSlot(this.live(key, now), now);
  }

  private secondsUntilSlot(list: number[], now: number): number {
    const oldest = list[0];
    return oldest === undefined
      ? Math.ceil(this.windowMs / 1_000)
      : Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1_000));
  }
}

// ------------------------------------------------------------------ error bodies
const forcedErrors = new WeakSet<ApiError>();

function apiError(status: number, body: ApiErrorBody, forced = false): ApiError {
  const error = new ApiError(status, body);
  if (forced) forcedErrors.add(error);
  return error;
}

const fromEngine = (failure: { status: number; body: ApiErrorBody }) =>
  apiError(failure.status, failure.body);

function unwrap<T>(result: EngineResult<T>): T {
  if (!result.ok) throw fromEngine(result);
  return result.value;
}

const validation = (issues: Issue[], forced = false) =>
  apiError(400, { error: 'validation_failed', message: 'The request is invalid.', issues }, forced);
const notAGuest = (forced = false) =>
  apiError(
    401,
    { error: 'not_a_guest', message: 'There is no guest session on this browser.' },
    forced,
  );
const rateLimited = (retryAfterSeconds: number, forced = false) =>
  apiError(
    429,
    { error: 'rate_limited', message: 'Too many requests. Try again shortly.', retryAfterSeconds },
    forced,
  );
const internal = (forced = false) =>
  apiError(500, { error: 'internal_error', message: 'Something went wrong on our side.' }, forced);
const inProgress = (forced = false) =>
  apiError(
    409,
    {
      error: 'request_in_progress',
      message: 'A request with this idempotency key is still being processed.',
    },
    forced,
  );
const keyReused = (forced = false) =>
  apiError(
    422,
    {
      error: 'idempotency_key_reused',
      message: 'This idempotency key was already used with a different request.',
    },
    forced,
  );

/** Where each forced order error sits in the validation order; a natural failure earlier than it still wins. */
const ORDER_STEP: Record<string, number> = {
  duplicate_order: 0,
  invalid_quantity: 1,
  invalid_price: 2,
  too_many_open_orders: 3,
  no_liquidity: 4,
  insufficient_funds: 4,
};

// ------------------------------------------------------------------ schema checks
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function decimalIssue(value: unknown, path: string): Issue | null {
  return typeof value === 'string' && DECIMAL.test(value)
    ? null
    : { path, message: 'Must be a decimal string.' };
}

function orderIssues(request: unknown, idempotencyKey: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isRecord(request)) return [{ path: '', message: 'Must be an object.' }];
  if (request.type !== 'limit' && request.type !== 'market')
    issues.push({ path: 'type', message: 'Must be "limit" or "market".' });
  if (typeof request.clientOrderId !== 'string' || !CLIENT_ID.test(request.clientOrderId)) {
    issues.push({
      path: 'clientOrderId',
      message: 'Must be 8–64 characters of A–Z, a–z, 0–9, "_" or "-".',
    });
  }
  if (request.side !== 'buy' && request.side !== 'sell')
    issues.push({ path: 'side', message: 'Must be "buy" or "sell".' });
  const quantity = decimalIssue(request.quantity, 'quantity');
  if (quantity) issues.push(quantity);
  if (request.type === 'limit') {
    const price = decimalIssue(request.limitPrice, 'limitPrice');
    if (price) issues.push(price);
  } else if (request.type === 'market' && request.limitPrice !== undefined) {
    issues.push({ path: 'limitPrice', message: 'A market order must not carry a limit price.' });
  }
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 255)
  ) {
    issues.push({ path: 'Idempotency-Key', message: 'Must be 8–255 characters.' });
  }
  return issues;
}

function cashIssue(value: unknown, path: string): Issue | null {
  const cents = parseCash(value);
  if (typeof value !== 'string' || cents === null || !DECIMAL.test(value)) {
    return { path, message: 'Must be a decimal string with at most 2 fractional digits.' };
  }
  return cents > 0n ? null : { path, message: 'Must be greater than 0.' };
}

function intIssue(value: unknown, path: string, lo: number, hi: number): Issue | null {
  if (value === undefined) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi
    ? null
    : { path, message: `Must be an integer from ${lo} to ${hi}.` };
}

function check(...issues: (Issue | null)[]): void {
  const found = issues.filter((i): i is Issue => i !== null);
  if (found.length > 0) throw validation(found);
}

const signatureOf = (r: PlaceOrderRequest): string =>
  JSON.stringify([
    r.type,
    r.clientOrderId,
    r.side,
    r.quantity,
    r.type === 'limit' ? r.limitPrice : null,
  ]);

/** Deliberately broken wire values so the UI's "—" fallbacks can be exercised. */
function corrupt(snapshot: MarketSnapshot): MarketSnapshot {
  const bid = snapshot.book.bids[0];
  if (bid) bid.price = 'abc';
  const ask = snapshot.book.asks[1] ?? snapshot.book.asks[0];
  if (ask) ask.quantity = '';
  const trade = snapshot.tape[0];
  if (trade) trade.createdAt = 'not-a-date';
  const second = snapshot.tape[1];
  if (second) second.price = 'abc';
  snapshot.stats.high = 'abc';
  snapshot.market.lastTradeAt = 'not-a-date';
  return snapshot;
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

function readStored(): StoredSession | null {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      typeof parsed.token !== 'string' ||
      typeof parsed.displayName !== 'string' ||
      typeof parsed.handle !== 'string' ||
      typeof parsed.createdAt !== 'number'
    )
      return null;
    return {
      token: parsed.token,
      displayName: parsed.displayName,
      handle: parsed.handle,
      createdAt: parsed.createdAt,
      demo: parsed.demo === true,
    };
  } catch {
    return null;
  }
}

function writeStored(session: StoredSession | null): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage can be unavailable (private mode); the session then lasts as long as the tab's memory.
  }
}

function newToken(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

// ------------------------------------------------------------------ client
export class MockApiClient implements ApiClient {
  readonly #engine: () => MatchingEngine;
  /** The HttpOnly cookie: never handed to callers. */
  #session: StoredSession | null = readStored();
  readonly #orders = new SlidingWindow(120, 60_000);
  readonly #movements = new SlidingWindow(30, 60_000);
  readonly #guests = new SlidingWindow(20, 3_600_000);
  readonly #deposits = new SlidingWindow(10, 3_600_000);
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #equity = new EquityRecorder();
  readonly #withdrawals: Withdrawal[] = [];

  constructor(opts: { engine: () => MatchingEngine }) {
    this.#engine = opts.engine;
  }

  // ---------------------------------------------------------------- hooks for index.ts
  hasDemoSession(): boolean {
    return this.#session?.demo === true;
  }

  attachSession(id: ParticipantId, demo: boolean): void {
    const identity = this.#engine().guestIdentity(id);
    if (!identity) return;
    const token = this.#session?.token ?? newToken();
    this.#engine().bindSession(token, id);
    this.#session = { token, ...identity, demo };
    writeStored(this.#session);
  }

  engineReplaced(): void {
    this.#idempotency.clear();
    this.#equity.clear();
    this.#withdrawals.length = 0;
  }

  // ---------------------------------------------------------------- plumbing
  #latency(): { up: number; server: number; down: number } {
    const mode = devSwitches.get().latency;
    if (mode === 'none') return { up: 0, server: 0, down: 0 };
    const total = mode === 'slow' ? 1_500 + Math.random() * 1_500 : 40 + Math.random() * 120;
    return { up: total * 0.4, server: total * 0.2, down: total * 0.4 };
  }

  /** One round trip. `handler` runs "on the server"; it may await `serverTime` to hold the request open. */
  async #exchange<T>(handler: (serverTime: () => Promise<void>) => T | Promise<T>): Promise<T> {
    const { up, server, down } = this.#latency();
    await sleep(up);
    let spent = false;
    const serverTime = () => {
      spent = true;
      return sleep(server);
    };
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await handler(serverTime) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    await sleep(spent ? down : server + down);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  #forget(): void {
    this.#session = null;
    writeStored(null);
  }

  /** Resolves the cookie to a participant. A plain guest whose engine was rebuilt is re-created from the cookie. */
  #participant(): ParticipantId | null {
    const session = this.#session;
    if (!session) return null;
    const engine = this.#engine();
    const id = engine.resolveSession(session.token);
    if (id !== null) return id;
    if (session.demo) {
      this.#forget();
      return null;
    }
    const restored = engine.createGuest({
      displayName: session.displayName,
      handle: session.handle,
      createdAt: session.createdAt,
    });
    this.attachSession(restored, false);
    return restored;
  }

  #guest(forced = false): { id: ParticipantId; token: string } {
    const id = this.#participant();
    const token = this.#session?.token;
    if (id === null || token === undefined || forced) throw notAGuest(forced);
    return { id, token };
  }

  #limit(window: SlidingWindow, key: string, forced: boolean): void {
    const now = Date.now();
    if (forced) throw rateLimited(window.retryAfter(key, now), true);
    const wait = window.blocked(key, now);
    if (wait !== null) throw rateLimited(wait);
    window.record(key, now);
  }

  #remember(slot: string, record: IdempotencyRecord): void {
    this.#idempotency.delete(slot);
    this.#idempotency.set(slot, record);
    if (this.#idempotency.size > IDEMPOTENCY_KEEP) {
      const oldest = this.#idempotency.keys().next().value;
      if (oldest !== undefined) this.#idempotency.delete(oldest);
    }
  }

  #sessionRead<T>(
    read: (engine: MatchingEngine, id: ParticipantId) => T,
    validate: () => void,
  ): Promise<T> {
    return this.#exchange(() => {
      if (devSwitches.get().sessionDown) throw internal(true);
      validate();
      const { id } = this.#guest();
      return read(this.#engine(), id);
    });
  }

  // ---------------------------------------------------------------- session
  enterAsGuest(): Promise<{
    participant: Participant;
    startingCash: CashAmount;
    created: boolean;
  }> {
    return this.#exchange(() => {
      const engine = this.#engine();
      const existing = this.#participant();
      if (existing !== null) {
        const me = engine.getMe(existing);
        return { participant: me.participant, startingCash: me.startingCash, created: false };
      }
      this.#limit(this.#guests, 'address', devSwitches.get().forceGuestError === 'rate_limited');
      const id = engine.createGuest();
      this.attachSession(id, false);
      const me = engine.getMe(id);
      return { participant: me.participant, startingCash: me.startingCash, created: true };
    });
  }

  logout(): Promise<void> {
    return this.#exchange(() => {
      if (this.#session) this.#engine().endSession(this.#session.token);
      this.#forget();
    });
  }

  getMe(): Promise<Me | null> {
    return this.#exchange(() => {
      if (devSwitches.get().sessionDown) throw internal(true);
      const id = this.#participant();
      return id === null ? null : this.#engine().getMe(id);
    });
  }

  // ---------------------------------------------------------------- market data
  getMarket(opts: { depth?: number; tape?: number } = {}): Promise<MarketSnapshot> {
    return this.#exchange(() => {
      const switches = devSwitches.get();
      if (switches.marketDown) throw new NetworkError();
      check(intIssue(opts.depth, 'depth', 1, 50), intIssue(opts.tape, 'tape', 1, 100));
      const snapshot = this.#engine().getMarket(opts.depth ?? 15, opts.tape ?? 40);
      return switches.malformed ? corrupt(snapshot) : snapshot;
    });
  }

  getCandles(interval: CandleInterval, limit = 240): Promise<CandlesResponse> {
    return this.#exchange(() => {
      if (devSwitches.get().marketDown) throw new NetworkError();
      check(
        interval === '1m' || interval === '5m' || interval === '1h'
          ? null
          : { path: 'interval', message: 'Must be 1m, 5m or 1h.' },
        intIssue(limit, 'limit', 1, 500),
      );
      return this.#engine().getCandles(interval, limit);
    });
  }

  // ---------------------------------------------------------------- orders
  placeOrder(request: PlaceOrderRequest, idempotencyKey?: string): Promise<PlaceOrderResult> {
    return this.#exchange(async (serverTime) => {
      const forced = devSwitches.get().forceOrderError;
      const issues = orderIssues(request, idempotencyKey);
      if (issues.length > 0) throw validation(issues);
      if (forced === 'validation_failed') {
        throw validation([{ path: 'quantity', message: 'Must be a decimal string.' }], true);
      }
      const { token } = this.#guest(forced === 'not_a_guest');
      this.#limit(this.#orders, token, forced === 'rate_limited');
      if (forced === 'request_in_progress') throw inProgress(true);
      if (forced === 'idempotency_key_reused') throw keyReused(true);

      const signature = signatureOf(request);
      const slot = idempotencyKey === undefined ? null : `${token}\u0000${idempotencyKey}`;
      if (slot !== null) {
        const prior = this.#idempotency.get(slot);
        if (prior?.state === 'in_flight') throw inProgress();
        if (prior && prior.signature !== signature) throw keyReused();
        if (prior?.state === 'failed') throw prior.error;
        if (prior?.state === 'done') return { ...prior.result, replayed: true };
        this.#remember(slot, { signature, state: 'in_flight' });
      }
      try {
        await serverTime();
        const result = this.#executeOrder(request, forced);
        if (slot !== null) this.#remember(slot, { signature, state: 'done', result });
        return result;
      } catch (error) {
        if (slot !== null) {
          const replayable =
            error instanceof ApiError &&
            !forcedErrors.has(error) &&
            error.status < 500 &&
            error.status !== 429 &&
            error.status !== 401;
          if (replayable) this.#remember(slot, { signature, state: 'failed', error });
          else this.#idempotency.delete(slot);
        }
        throw error;
      }
    });
  }

  #executeOrder(request: PlaceOrderRequest, forced: ForcedOrderError | null): PlaceOrderResult {
    const { id } = this.#guest();
    const engine = this.#engine();
    const natural = engine.checkOrder(id, request);
    const forcedStep = forced === null ? undefined : ORDER_STEP[forced];
    const naturalStep = natural ? (ORDER_STEP[natural.body.error] ?? -1) : Number.POSITIVE_INFINITY;
    if (forced !== null && forcedStep !== undefined && forcedStep <= naturalStep) {
      throw this.#forcedOrderError(forced, id, request);
    }
    if (natural) throw fromEngine(natural);
    if (forced === 'internal_error') throw internal(true);
    const placed = unwrap(engine.placeOrder(id, request));
    return { order: placed.order, fills: placed.fills, replayed: false };
  }

  #forcedOrderError(
    code: ForcedOrderError,
    id: ParticipantId,
    request: PlaceOrderRequest,
  ): ApiError {
    const body = (status: number, message: string, extra: Partial<ApiErrorBody> = {}) =>
      apiError(status, { error: code, message, ...extra }, true);
    switch (code) {
      case 'duplicate_order':
        return body(409, `An order with clientOrderId "${request.clientOrderId}" already exists.`);
      case 'invalid_quantity':
        return body(422, 'Quantity must be a positive multiple of 0.01, at most 100000.');
      case 'invalid_price':
        return body(422, 'Price must be a multiple of 0.01 between 1.00 and 10000.00.');
      case 'too_many_open_orders':
        return body(422, 'You already have 50 open orders.');
      case 'no_liquidity':
        return body(422, 'There is nothing on the other side of the book to fill against.');
      case 'insufficient_funds': {
        const need = this.#engine().orderRequirement(id, request);
        return body(422, `Not enough ${need.unit} available.`, {
          unit: need.unit,
          available: need.available,
          required: need.required,
        });
      }
      default:
        return internal(true);
    }
  }

  listOrders(
    opts: { status?: 'open' | 'all'; limit?: number } = {},
  ): Promise<{ orders: ExchangeOrder[] }> {
    return this.#sessionRead(
      (engine, id) => ({ orders: engine.listOrders(id, opts.status ?? 'all', opts.limit ?? 100) }),
      () =>
        check(
          opts.status === undefined || opts.status === 'open' || opts.status === 'all'
            ? null
            : { path: 'status', message: 'Must be "open" or "all".' },
          intIssue(opts.limit, 'limit', 1, 500),
        ),
    );
  }

  cancelOrder(clientOrderId: string): Promise<{ status: 'cancelled' }> {
    return this.#exchange(() => {
      const forced = devSwitches.get().forceCancelError;
      check(
        typeof clientOrderId === 'string' && clientOrderId.length > 0 && clientOrderId.length <= 64
          ? null
          : { path: 'clientOrderId', message: 'Must be 1–64 characters.' },
      );
      const { id, token } = this.#guest();
      this.#limit(this.#orders, token, forced === 'rate_limited');
      if (forced === 'unknown_order') {
        throw apiError(
          404,
          { error: 'unknown_order', message: `No order with clientOrderId "${clientOrderId}".` },
          true,
        );
      }
      if (forced === 'order_not_open') {
        throw apiError(
          409,
          {
            error: 'order_not_open',
            message: `Order "${clientOrderId}" is already filled or cancelled.`,
          },
          true,
        );
      }
      return unwrap(this.#engine().cancelOrder(id, clientOrderId));
    });
  }

  listFills(limit?: number): Promise<{ fills: OwnFill[] }> {
    return this.#sessionRead(
      (engine, id) => ({ fills: engine.listFills(id, limit ?? 100) }),
      () => check(intIssue(limit, 'limit', 1, 500)),
    );
  }

  // ---------------------------------------------------------------- cash
  #forcedCash(
    code: ForcedCashError | null,
    applies: ForcedCashError[],
    id: ParticipantId,
    amount: bigint,
    clientId?: string,
  ): void {
    if (code === null || !applies.includes(code)) return;
    const raise = (status: number, message: string, extra: Partial<ApiErrorBody> = {}): never => {
      throw apiError(status, { error: code, message, ...extra }, true);
    };
    switch (code) {
      case 'amount_too_large':
        return raise(
          422,
          clientId === undefined
            ? 'Deposits are limited to 10000.00 each.'
            : 'Withdrawals and transfers are limited to 1000000.00 each.',
        );
      case 'deposit_limit':
        return raise(429, 'You can make 10 deposits an hour.', {
          retryAfterSeconds: this.#deposits.retryAfter(this.#session?.token ?? '', Date.now()),
        });
      case 'insufficient_funds': {
        const available = this.#engine().cashAvailable(id);
        return raise(422, 'Not enough USD available.', {
          unit: 'USD',
          available: formatCash(available),
          required: formatCash(amount),
        });
      }
      case 'unknown_recipient':
        return raise(404, 'No guest has that handle.');
      case 'self_transfer':
        return raise(422, 'That is your own handle.');
      case 'duplicate_movement':
        return raise(409, `A movement with clientId "${clientId ?? ''}" already exists.`);
      case 'internal_error':
        throw internal(true);
      case 'rate_limited':
        return;
    }
  }

  deposit(request: { amount: CashAmount; deliveries?: number }): Promise<DepositResult> {
    return this.#exchange(() => {
      const forced = devSwitches.get().forceCashError;
      check(
        isRecord(request)
          ? cashIssue(request.amount, 'amount')
          : { path: '', message: 'Must be an object.' },
        intIssue(request.deliveries, 'deliveries', 1, 10),
      );
      const { id, token } = this.#guest();
      this.#limit(this.#movements, token, forced === 'rate_limited');
      const amount = parseCash(request.amount) ?? 0n;
      this.#forcedCash(forced, ['amount_too_large'], id, amount);
      if (amount > MAX_DEPOSIT) {
        throw apiError(422, {
          error: 'amount_too_large',
          message: 'Deposits are limited to 10000.00 each.',
        });
      }
      this.#forcedCash(forced, ['deposit_limit'], id, amount);
      const wait = this.#deposits.blocked(token, Date.now());
      if (wait !== null) {
        throw apiError(429, {
          error: 'deposit_limit',
          message: 'You can make 10 deposits an hour.',
          retryAfterSeconds: wait,
        });
      }
      this.#forcedCash(forced, ['internal_error'], id, amount);
      const result = unwrap(this.#engine().deposit(id, amount, request.deliveries ?? 1));
      this.#deposits.record(token, Date.now());
      return result;
    });
  }

  withdraw(request: { clientId: string; amount: CashAmount }): Promise<MovementResult> {
    return this.#exchange(() => {
      const forced = devSwitches.get().forceCashError;
      check(
        isRecord(request) &&
          typeof request.clientId === 'string' &&
          CLIENT_ID.test(request.clientId)
          ? null
          : { path: 'clientId', message: 'Must be 8–64 characters of A–Z, a–z, 0–9, "_" or "-".' },
        cashIssue(request.amount, 'amount'),
      );
      const { id, token } = this.#guest();
      this.#limit(this.#movements, token, forced === 'rate_limited');
      const amount = parseCash(request.amount) ?? 0n;
      this.#forcedCash(
        forced,
        ['duplicate_movement', 'amount_too_large', 'insufficient_funds', 'internal_error'],
        id,
        amount,
        request.clientId,
      );
      const result = unwrap(this.#engine().withdraw(id, request.clientId, amount));
      // The mock has no payout rail: a withdrawal is paid out at once, and its
      // tracker shows the states the real saga would pass through.
      const existing = this.#withdrawals.find((w) => w.clientId === request.clientId);
      const withdrawalId = existing?.id ?? String(this.#withdrawals.length + 1);
      if (!existing) {
        const at = result.occurredAt;
        const step = (
          from: Withdrawal['state'] | null,
          to: Withdrawal['state'],
          reason: string,
        ) => ({
          from,
          to,
          reason,
          actor: 'mock',
          at,
        });
        this.#withdrawals.unshift({
          id: withdrawalId,
          clientId: request.clientId,
          amount: result.amount,
          state: 'confirmed',
          step: 3,
          outcome: 'paid_out',
          inReview: false,
          submitAttempts: 1,
          lastRailStatus: 'confirmed',
          createdAt: at,
          updatedAt: at,
          history: [
            step(null, 'requested', 'requested by the guest'),
            step('requested', 'held', 'cash moved to hold'),
            step('held', 'submitted', 'sent to the payout rail'),
            step('submitted', 'confirmed', 'rail confirmed the payout'),
          ],
        });
      }
      return { ...result, status: 'confirmed' as const, withdrawalId };
    });
  }

  listWithdrawals(limit?: number): Promise<{ withdrawals: Withdrawal[] }> {
    return this.#sessionRead(
      () => ({ withdrawals: this.#withdrawals.slice(0, limit ?? 20) }),
      () => check(intIssue(limit, 'limit', 1, 100)),
    );
  }

  transfer(request: {
    clientId: string;
    amount: CashAmount;
    toHandle: string;
  }): Promise<MovementResult> {
    return this.#exchange(() => {
      const forced = devSwitches.get().forceCashError;
      check(
        isRecord(request) &&
          typeof request.clientId === 'string' &&
          CLIENT_ID.test(request.clientId)
          ? null
          : { path: 'clientId', message: 'Must be 8–64 characters of A–Z, a–z, 0–9, "_" or "-".' },
        cashIssue(request.amount, 'amount'),
        typeof request.toHandle === 'string' && HANDLE.test(request.toHandle)
          ? null
          : { path: 'toHandle', message: 'Must be 10 characters of 0–9 and a–f.' },
      );
      const { id, token } = this.#guest();
      this.#limit(this.#movements, token, forced === 'rate_limited');
      const amount = parseCash(request.amount) ?? 0n;
      this.#forcedCash(
        forced,
        [
          'unknown_recipient',
          'self_transfer',
          'duplicate_movement',
          'amount_too_large',
          'insufficient_funds',
          'internal_error',
        ],
        id,
        amount,
        request.clientId,
      );
      return unwrap(this.#engine().transfer(id, request.clientId, amount, request.toHandle));
    });
  }

  lookupRecipient(handle: string): Promise<Recipient> {
    return this.#exchange(() => {
      const forced = devSwitches.get().forceCashError;
      check(
        typeof handle === 'string' && HANDLE.test(handle)
          ? null
          : { path: 'handle', message: 'Must be 10 characters of 0–9 and a–f.' },
      );
      const { id } = this.#guest();
      this.#forcedCash(forced, ['unknown_recipient', 'self_transfer'], id, 0n);
      return unwrap(this.#engine().lookupRecipient(id, handle));
    });
  }

  // ---------------------------------------------------------------- activity
  getActivity(limit?: number): Promise<ActivityResponse> {
    return this.#sessionRead(
      (engine, id) => engine.getActivity(id, limit ?? 50),
      () => check(intIssue(limit, 'limit', 1, 200)),
    );
  }

  // ---------------------------------------------------------------- projections
  getPosition(): Promise<Position> {
    return this.#sessionRead(
      (engine, id) => {
        const market = engine.getMarket(1, 1);
        return positionFromFills(
          engine.listFills(id, 500),
          market.market.symbol,
          market.market.lastPrice,
        );
      },
      () => undefined,
    );
  }

  getEquity(range: EquityRange): Promise<EquityResponse> {
    return this.#sessionRead(
      (engine, id) => {
        const market = engine.getMarket(1, 1);
        const points = this.#equity.record(engine.getMe(id), market.market.lastPrice, engine.now());
        const span = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }[range];
        const since = engine.now() - span;
        return { points: points.filter((p) => Date.parse(p.at) >= since) };
      },
      () => undefined,
    );
  }

  // ---------------------------------------------------------------- notifications
  // The mock has no notifier; its bell is always empty. Live push is off in the
  // mock, so the page polls, as it would against a server with push disabled.
  getNotifications(): Promise<NotificationsResponse> {
    return this.#sessionRead(
      () => ({ unread: 0, notifications: [] }),
      () => undefined,
    );
  }

  markNotificationsRead(): Promise<{ marked: number }> {
    return this.#sessionRead(
      () => ({ marked: 0 }),
      () => undefined,
    );
  }

  // ---------------------------------------------------------------- recurring buys
  // The mock keeps plans but never fires them: there is no scheduler in the
  // browser. It is enough to stage the screens.
  readonly #plans: RecurringPlan[] = [];

  listRecurring(): Promise<{ plans: RecurringPlan[] }> {
    return this.#sessionRead(
      () => ({ plans: [...this.#plans] }),
      () => undefined,
    );
  }

  createRecurring(request: {
    amount: CashAmount;
    cadence: Cadence;
  }): Promise<{ plan: RecurringPlan }> {
    return this.#sessionRead(
      (engine) => {
        const every = { '1m': 60_000, '1h': 3_600_000, '1d': 86_400_000, '1w': 604_800_000 }[
          request.cadence
        ];
        const now = engine.now();
        const plan: RecurringPlan = {
          id: `rp-${crypto.randomUUID()}`,
          symbol: 'DFT',
          amount: request.amount,
          cadence: request.cadence,
          everyMs: every,
          status: 'active',
          nextRunAt: new Date(Math.floor(now / every) * every + every).toISOString(),
          bought: '0.00000000',
          spent: '0.00',
          averagePrice: null,
          runs: [],
          createdAt: new Date(now).toISOString(),
        };
        this.#plans.unshift(plan);
        return { plan };
      },
      () => check(cashIssue(request.amount, 'amount')),
    );
  }

  setRecurringActive(id: string, active: boolean): Promise<{ plan: RecurringPlan }> {
    return this.#sessionRead(
      () => {
        const plan = this.#plans.find((p) => p.id === id);
        if (!plan) throw apiError(404, { error: 'unknown_plan', message: 'no such recurring buy' });
        plan.status = active ? 'active' : 'paused';
        plan.nextRunAt = active ? plan.nextRunAt : null;
        return { plan: { ...plan } };
      },
      () => undefined,
    );
  }

  deleteRecurring(id: string): Promise<void> {
    return this.#sessionRead(
      () => {
        const i = this.#plans.findIndex((p) => p.id === id);
        if (i >= 0) this.#plans.splice(i, 1);
      },
      () => undefined,
    );
  }
}
