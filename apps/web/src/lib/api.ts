/**
 * # The API client
 *
 * ## Amounts stay strings in this file, and in every component
 *
 * The API sends every amount as an **exact decimal string** because JSON has no
 * integer type wide enough for an int8 and `number` cannot hold one without
 * losing precision. `JSON.parse` would happily turn `"9007199254740993"` into
 * `9007199254740992`, silently, and the display would be wrong by one minor
 * unit with nothing to indicate it.
 *
 * So: **nothing in the frontend parses an amount into a `number`.** Strings are
 * passed through to the formatter and rendered. Where arithmetic is genuinely
 * needed — the Trade page's estimated cost — it is done in `BigInt` on minor
 * units, in `money.ts`, never in floating point.
 *
 * The only numbers that become `number` are counts and durations, which are
 * small by construction.
 */

/** Everything is same-origin — the dev server proxies, production co-serves. */
const BASE = '';

/**
 * Fields are declared and assigned, not written as constructor parameter
 * properties. `erasableSyntaxOnly` is on repo-wide (see tsconfig.base.json)
 * because Node runs this TypeScript by stripping types, and a parameter
 * property is syntax that *generates* code rather than being erased — so it is
 * a compile error here rather than something that works in the bundler and
 * breaks under `node`.
 */
export class ApiError extends Error {
  readonly status: number;
  /** The API's machine-readable `error` code, e.g. `insufficient_funds`. */
  readonly code: string;
  /** The parsed body, for the few callers that need a field off it. */
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, signal } = options;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });

  // 204 and friends. `response.json()` on an empty body throws a SyntaxError
  // that reads like a server fault, which sends debugging in the wrong place.
  const text = await response.text();
  const parsed: unknown = text.length === 0 ? null : JSON.parse(text);

  if (!response.ok) {
    const shape = parsed as { error?: unknown; message?: unknown } | null;
    throw new ApiError(
      response.status,
      typeof shape?.error === 'string' ? shape.error : 'request_failed',
      typeof shape?.message === 'string'
        ? shape.message
        : `${method} ${path} → ${String(response.status)}`,
      parsed,
    );
  }

  return parsed as T;
}

/* ------------------------------------------------------------------ accounts */

export interface Account {
  externalId: string;
  kind: string;
  /** `null` for a cash account; the symbol for a position account. */
  assetSymbol: string | null;
  /** Exact decimal string. Never a number. */
  balance: string;
  createdAt: string;
}

export const getAccount = (externalId: string): Promise<Account> =>
  request(`/v1/accounts/${encodeURIComponent(externalId)}`);

/* --------------------------------------------------------------- instruments */

export interface Instrument {
  symbol: string;
  displayName: string;
  /**
   * The price orders are actually priced at — the frozen reference price from
   * the `instruments` table, **not** the live Binance ticker.
   *
   * The UI shows both, labelled, because they differ and pretending otherwise
   * would be the single most misleading thing this interface could do.
   */
  referencePrice: string;
  referencePriceAt: string;
}

export const listInstruments = (): Promise<Instrument[]> => request('/v1/instruments');

/* -------------------------------------------------------------------- orders */

export interface PlaceOrderInput {
  externalId: string;
  accountId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: string;
}

export interface Order {
  externalId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: string;
  /** The price frozen into this order. Never re-read after placement. */
  price: string;
  notional: string;
  status: 'pending' | 'settled' | 'rejected';
  transactionId: string;
  cashBalanceAfter: string;
  assetBalanceAfter: string;
  /** How many tries the ledger write took. Non-trivial only under serializable. */
  attempts: number;
}

export const placeOrder = (
  input: PlaceOrderInput,
  options: { idempotencyKey?: string; concurrencyMode?: string } = {},
): Promise<Order> =>
  request('/v1/orders', {
    method: 'POST',
    body: input,
    headers: {
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
      ...(options.concurrencyMode === undefined
        ? {}
        : { 'x-daftar-concurrency-mode': options.concurrencyMode }),
    },
  });

/* ------------------------------------------------------------------ reports */

export interface Positions {
  externalId: string;
  cash: string;
  positions: {
    symbol: string;
    quantity: string;
    /** `null` when the position exists but no order explains it. */
    costBasis: string | null;
    referencePrice: string;
    marketValue: string;
  }[];
}

export const getPositions = (externalId: string): Promise<Positions> =>
  request(`/v1/accounts/${encodeURIComponent(externalId)}/positions`);

export interface StatementRow {
  entryId: string;
  createdAt: string;
  transactionId: string;
  transactionKind: string;
  direction: 'debit' | 'credit';
  unit: string;
  amount: string;
  runningBalance: string;
}

export interface Statement {
  account: { externalId: string; kind: string; unit: string };
  rows: StatementRow[];
}

export const getStatement = (externalId: string, limit = 100): Promise<Statement> =>
  request(`/v1/accounts/${encodeURIComponent(externalId)}/statement?limit=${String(limit)}`);

export interface Leg {
  accountExternalId: string;
  accountKind: string;
  direction: 'debit' | 'credit';
  unit: string;
  amount: string;
}

export interface Transaction {
  id: string;
  kind: string;
  createdAt: string;
  legs: Leg[];
  order: {
    externalId: string;
    symbol: string;
    side: 'buy' | 'sell';
    quantity: string;
    price: string;
    notional: string;
    status: string;
    idempotencyKey: string | null;
  } | null;
  webhookEvent: {
    id: string;
    provider: string;
    idempotencyKey: string;
    eventType: string;
  } | null;
}

export interface TransactionPage {
  transactions: Transaction[];
  nextCursor: string | null;
}

export const getTransactions = (
  externalId: string,
  options: { limit?: number; before?: string } = {},
): Promise<TransactionPage> => {
  const params = new URLSearchParams({ limit: String(options.limit ?? 25) });
  if (options.before !== undefined) params.set('before', options.before);
  return request(
    `/v1/accounts/${encodeURIComponent(externalId)}/transactions?${params.toString()}`,
  );
};

/* -------------------------------------------------------------- settlements */

export interface WebhookEvent {
  id: string;
  provider: string;
  eventId: string;
  objectId: string;
  eventType: string;
  signatureValid: boolean;
  withinWindow: boolean;
  payloadHash: string;
  state: string;
  deliveryCount: number;
  duplicate: boolean;
  payloadConflictCount: number;
  transactionId: string | null;
  errorDetail: string | null;
  receivedAt: string;
  processedAt: string | null;
}

export interface WebhookEventPage {
  events: WebhookEvent[];
  nextCursor: string | null;
}

export const getWebhookEvents = (
  options: { limit?: number; before?: string } = {},
): Promise<WebhookEventPage> => {
  const params = new URLSearchParams({ limit: String(options.limit ?? 25) });
  if (options.before !== undefined) params.set('before', options.before);
  return request(`/v1/webhooks/events?${params.toString()}`);
};

export interface ReplayResult {
  replayed: true;
  status: number;
  body: unknown;
}

export const replayWebhookEvent = (id: string): Promise<ReplayResult> =>
  request(`/v1/webhooks/events/${encodeURIComponent(id)}/replay`, { method: 'POST' });

/* -------------------------------------------------------------------- chaos */

export interface ChaosSession {
  token: string;
  tenant: string;
  expiresAt: number;
  ttlSeconds: number;
  limits: { maxVirtualUsers: number; maxAccountSpread: number };
}

export const createChaosSession = (): Promise<ChaosSession> =>
  request('/v1/chaos/session', { method: 'POST' });

export type ChaosProfile =
  | { kind: 'order'; mode: 'pessimistic' | 'serializable' | 'advisory' }
  | { kind: 'debit'; strategy: 'naive_overdraft' | 'naive_lost_update' | 'guarded_atomic' };

export interface BurstInvariants {
  entriesSumToZeroPerUnit: boolean;
  unitSums: { unit: string; sum: string }[];
  overdrawnAccounts: { externalId: string; balance: string }[];
  overdraftOccurred: boolean;
  /** `null` for the debit profiles, which keep no ledger. Not a failure. */
  balanceMatchesEntries: boolean | null;
  drift: { externalId: string; balance: string; entriesSum: string }[];
  expectedCash: string | null;
  actualCash: string | null;
  cashDiscrepancy: string | null;
}

export interface BurstResult {
  tenant: string;
  profile: ChaosProfile;
  virtualUsers: number;
  accountSpread: number;
  attempted: number;
  succeeded: number;
  refused: number;
  errored: number;
  totalAttempts: number;
  serializationFailures: number;
  deadlocks: number;
  durationMs: number;
  throughput: number;
  openingPerAccount: string;
  invariants: BurstInvariants;
}

export const fireBurst = (
  token: string,
  body: { profile: ChaosProfile; virtualUsers: number; accountSpread: number },
): Promise<BurstResult> =>
  request('/v1/chaos/burst', {
    method: 'POST',
    body,
    headers: { 'x-daftar-chaos-token': token },
  });

/* ------------------------------------------------------------------- health */

export interface Health {
  status: string;
  checks?: Record<string, unknown>;
}

export const getHealth = (): Promise<Health> => request('/health/ready');

export { request as apiRequest };
