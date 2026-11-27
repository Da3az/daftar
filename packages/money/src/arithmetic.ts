import { QUANTITY_SCALE, type CashMinor, type PriceMinor, type Quantity } from './scale.ts';

export const add = (a: bigint, b: bigint): bigint => a + b;
export const sub = (a: bigint, b: bigint): bigint => a - b;
export const neg = (a: bigint): bigint => -a;
export const abs = (a: bigint): bigint => (a < 0n ? -a : a);
export const isZero = (a: bigint): boolean => a === 0n;

/**
 * `sum` exists so there is no reason to reach for `Array.prototype.reduce` with a
 * `0` seed. `[1n, 2n].reduce((a, b) => a + b, 0)` is a TypeError at runtime
 * (cannot mix BigInt and other types) and `0` is the natural thing to type.
 */
export const sum = (values: readonly bigint[]): bigint => {
  let total = 0n;
  for (const v of values) total += v;
  return total;
};

export const cmp = (a: bigint, b: bigint): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Integer division with **half-up rounding away from zero**, exact for all inputs.
 *
 * Policy, stated once here because an unstated rounding mode is how a ledger
 * acquires a slow leak:
 *
 *   -  2.5 ->  3   |  -2.5 -> -3     (ties go away from zero)
 *   -  2.4 ->  2   |  -2.4 -> -2
 *
 * Half-up-away-from-zero is symmetric, so rounding a value and rounding its
 * negation give results that still sum to zero — which matters here, because both
 * legs of a double-entry transaction are derived from the same rounded notional
 * and must cancel exactly.
 *
 * Half-even ("banker's rounding") would have a smaller bias over many random
 * values, but is not what a brokerage confirmation shows a customer, and the bias
 * argument is irrelevant when both legs use the same single rounded figure.
 */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('division by zero');

  // Normalise so the denominator is positive; sign is reattached at the end.
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const q = n / d;
  const r = n % d;

  // Compare 2r against d rather than computing r/d, to stay in integers.
  const rounded = 2n * r >= d ? q + 1n : q;

  return negative ? -rounded : rounded;
}

const QUANTITY_DIVISOR = 10n ** BigInt(QUANTITY_SCALE);

/**
 * Cash value of `quantity` units of an asset at `price`.
 *
 * `quantity` is at QUANTITY_SCALE (1e-8 units); `price` is cash minor units per
 * one *whole* asset unit. The result is cash minor units, rounded per `divRound`.
 *
 * This function makes **no network call** and reads no clock. The price is passed
 * in because it was frozen into the order at order time.
 * That is what keeps the benchmarks reproducible: a live lookup here would
 * make every benchmark run produce different amounts.
 */
export function notional(quantity: Quantity, price: PriceMinor): CashMinor {
  return divRound(quantity * price, QUANTITY_DIVISOR);
}
