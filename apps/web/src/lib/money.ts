/* Exact money arithmetic. Amounts are decimal strings on the wire and BigInt minor units in here.
   Nothing in this file may turn an amount into a `number`, except the two functions at the bottom,
   which exist for pixel geometry only and are marked. */

export const CASH_DECIMALS = 2;
export const QTY_DECIMALS = 8;
const QTY_SCALE = 10n ** BigInt(QTY_DECIMALS);

/** Parse an exact decimal string with at most `decimals` fractional digits. null when malformed. */
export function parseUnits(value: unknown, decimals: number): bigint | null {
  if (typeof value !== 'string') return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > decimals) return null;
  const units = BigInt(whole + fraction.padEnd(decimals, '0'));
  return sign === '-' ? -units : units;
}

export const parseCash = (value: unknown): bigint | null => parseUnits(value, CASH_DECIMALS);
export const parseQty = (value: unknown): bigint | null => parseUnits(value, QTY_DECIMALS);

/** Minor units back to an exact decimal string with exactly `decimals` fractional digits. */
export function formatUnits(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? `.${digits.slice(digits.length - decimals)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

export const formatCash = (cents: bigint): string => formatUnits(cents, CASH_DECIMALS);
export const formatQty = (units: bigint): string => formatUnits(units, QTY_DECIMALS);

/** price (cents) × quantity (1e-8 coins) → cents, rounded half up. Exact for lot-multiple quantities. */
export function notional(priceCents: bigint, qtyUnits: bigint): bigint {
  const product = priceCents * qtyUnits;
  return (product + QTY_SCALE / 2n) / QTY_SCALE;
}

/** How many whole lots of `lotUnits` a cash amount buys at a price. */
export function affordableQty(cashCents: bigint, priceCents: bigint, lotUnits: bigint): bigint {
  if (priceCents <= 0n || lotUnits <= 0n || cashCents <= 0n) return 0n;
  const raw = (cashCents * QTY_SCALE) / priceCents;
  return raw - (raw % lotUnits);
}

/** value × percent / 100, floored to a multiple of `step`. */
export function percentOf(value: bigint, percent: number, step: bigint): bigint {
  const raw = (value * BigInt(percent)) / 100n;
  return step > 0n ? raw - (raw % step) : raw;
}

const group = (whole: string): string => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const DASH = '—';

/** Display: "10,000.00". Total — a malformed value renders as an em dash, never throws. */
export function showCash(value: unknown, opts: { sign?: boolean } = {}): string {
  const cents = typeof value === 'bigint' ? value : parseCash(value);
  if (cents === null) return DASH;
  const text = formatCash(cents < 0n ? -cents : cents);
  const [whole = '0', fraction = '00'] = text.split('.');
  const sign = cents < 0n ? '−' : opts.sign && cents > 0n ? '+' : '';
  return `${sign}${group(whole)}.${fraction}`;
}

/** Display a quantity at `places` fractional digits (2 = the lot size). Truncates, never rounds up. */
export function showQty(value: unknown, places = 2): string {
  const units = typeof value === 'bigint' ? value : parseQty(value);
  if (units === null) return DASH;
  const text = formatQty(units < 0n ? -units : units);
  const [whole = '0', fraction = ''] = text.split('.');
  const shown = places > 0 ? `.${fraction.slice(0, places)}` : '';
  return `${units < 0n ? '−' : ''}${group(whole)}${shown}`;
}

/** Signed percent change of `now` against `base`, two places: "+0.12%". */
export function showPercentChange(now: unknown, base: unknown): string {
  const a = parseCash(now);
  const b = parseCash(base);
  if (a === null || b === null || b === 0n) return DASH;
  const bps = ((a - b) * 1_000_000n) / b; // percent × 10^4
  const rounded = (bps + (bps >= 0n ? 50n : -50n)) / 100n; // percent × 100
  const text = formatUnits(rounded < 0n ? -rounded : rounded, 2);
  return `${rounded < 0n ? '−' : rounded > 0n ? '+' : ''}${text}%`;
}

export function compareDecimal(a: string, b: string, decimals: number): number {
  const x = parseUnits(a, decimals);
  const y = parseUnits(b, decimals);
  if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
  return x < y ? -1 : x > y ? 1 : 0;
}

/* ------------------------------------------------------------------------------------------
   SANCTIONED float exceptions. Pixel geometry only — bar widths and chart coordinates.
   The results must never be formatted and shown as an amount.
   ------------------------------------------------------------------------------------------ */

/** part / whole as a 0..1 float for a bar width. */
export function ratioForBar(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  return Math.min(1, Number((part * 10_000n) / whole) / 10_000);
}

/** A decimal string as a float for the chart library's y-axis and volume bars. NaN when malformed. */
export function numberForChart(value: unknown): number {
  return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
}
