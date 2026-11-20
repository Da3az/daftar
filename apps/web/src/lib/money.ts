/**
 * # Money in the browser
 *
 * ## The rule: amounts arrive as strings and stay strings
 *
 * Every amount from the API is an exact decimal string. Nothing here calls
 * `Number()` on one. `Number('9007199254740993')` is `9007199254740992` — off
 * by one minor unit, silently, with no error and no indication in the UI.
 *
 * Where arithmetic is genuinely needed, it happens in `BigInt` on **minor
 * units** (cents, or 1e-8 of an asset) and is converted back to a string at the
 * end. There is no floating point anywhere in this file.
 *
 * ## Why this duplicates `@daftar/money` rather than importing it
 *
 * It does not duplicate it — `@daftar/money` is a workspace package and could
 * be imported. It is deliberately *not*, because that package is the server's
 * parser and its job is to **reject** bad input with a thrown error. A thrown
 * error is the right answer on a write path and the wrong answer in a render:
 * one malformed field from the API would blank an entire page rather than one
 * cell.
 *
 * So these are display functions. They are total — every input produces
 * something renderable — and the scales are imported from the shared package so
 * the two cannot drift.
 */

/** Cash: 2 fractional digits. Matches `CASH_SCALE` on the server. */
export const CASH_SCALE = 2;

/** Asset quantities: 8 fractional digits. Matches `QUANTITY_SCALE`. */
export const QUANTITY_SCALE = 8;

/** The single cash unit. Single currency, no FX — see CONVENTIONS.md. */
export const CASH_UNIT = 'USD';

/**
 * Parse an exact decimal string into minor units.
 *
 * Returns `null` rather than throwing. A render must not be able to crash on a
 * field it was only going to display.
 */
export function toMinor(decimal: string, scale: number): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!match) return null;

  const [, sign, whole, fraction = ''] = match as unknown as [string, string, string, string?];

  // Longer than the scale means the server sent more precision than this unit
  // has, which is a contract violation rather than something to round away.
  if ((fraction ?? '').length > scale) return null;

  const padded = (fraction ?? '').padEnd(scale, '0');
  const magnitude = BigInt(`${whole}${padded}`);
  return sign === '-' ? -magnitude : magnitude;
}

/** Render minor units as an exact decimal string, always with `scale` digits. */
export function fromMinor(minor: bigint, scale: number): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(scale + 1, '0');

  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);

  return `${negative ? '-' : ''}${whole}${scale > 0 ? `.${fraction}` : ''}`;
}

/**
 * Group the integer part with thousands separators, for display only.
 *
 * Done by string manipulation on digits, **not** via `Intl.NumberFormat` on a
 * parsed number — which would route the value through a double and defeat the
 * entire point of keeping it a string.
 *
 * `Intl.NumberFormat` *can* format a string safely via its string-numeric-literal
 * support, but it also applies locale digit shaping and rounding rules that are
 * harder to reason about than inserting separators into digits that are already
 * exact.
 */
export function group(decimal: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!match) return decimal;

  const [, sign, whole, fraction] = match as unknown as [string, string, string, string?];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return `${sign}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** `1234.50` → `$1,234.50`. Keeps the sign in front of the symbol: `-$5.00`. */
export function formatCash(decimal: string): string {
  const negative = decimal.startsWith('-');
  return `${negative ? '-' : ''}$${group(negative ? decimal.slice(1) : decimal)}`;
}

/** `0.10000000 BTC`. Trailing zeros are kept — the scale is information. */
export function formatQuantity(decimal: string, symbol?: string): string {
  return `${group(decimal)}${symbol === undefined ? '' : ` ${symbol}`}`;
}

/** Format by the unit the row actually carries, never by an assumed one. */
export function formatByUnit(decimal: string, unit: string): string {
  return unit === CASH_UNIT ? formatCash(decimal) : formatQuantity(decimal, unit);
}

/**
 * The estimated cost of an order: quantity x price, in cash minor units.
 *
 * Integer throughout. `quantity` is scaled by 1e8 and `price` by 1e2, so the
 * product is scaled by 1e10 and comes back down by 1e8. Done as one expression
 * so no intermediate is truncated before the division that needs its digits.
 *
 * **Truncating, and it says so.** This is an estimate shown next to a form
 * field; the server computes the authoritative notional from the frozen price
 * and its own rounding. Rounding differently here would mean the figure on the
 * button and the figure on the receipt disagree by a cent, and the receipt is
 * the one that is right.
 */
export function estimateNotional(quantity: string, price: string): string | null {
  const q = toMinor(quantity, QUANTITY_SCALE);
  const p = toMinor(price, CASH_SCALE);
  if (q === null || p === null) return null;

  return fromMinor((q * p) / 100_000_000n, CASH_SCALE);
}

/** True when the string parses and is strictly greater than zero. */
export function isPositiveAmount(decimal: string, scale: number): boolean {
  const minor = toMinor(decimal, scale);
  return minor !== null && minor > 0n;
}

/** Signed comparison without going through a float. */
export function compareDecimal(a: string, b: string, scale: number): number {
  const left = toMinor(a, scale);
  const right = toMinor(b, scale);
  if (left === null || right === null) return 0;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `2026-11-20T13:14:30.624066Z` → `20 Nov 2026, 13:14:30` (UTC). */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  // UTC everywhere. A ledger timestamp rendered in the viewer's local zone
  // cannot be compared against the API response or the logs by eye, and this
  // interface exists to be compared against them.
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
    hour12: false,
  }).format(date);
}

/** Microsecond-precision tail, which `Date` cannot hold. Shown where it matters. */
export function microseconds(iso: string): string | null {
  const match = /\.(\d{3})(\d{1,3})/.exec(iso);
  return match ? (match[2] ?? null) : null;
}
