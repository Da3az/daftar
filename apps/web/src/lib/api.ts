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
 * needed — the order ticket's estimated cost — it is done in `BigInt` on minor
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

export { request as apiRequest };
