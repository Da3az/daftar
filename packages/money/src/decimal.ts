import { CASH_SCALE, QUANTITY_SCALE, type Scale } from './scale.js';

export class MoneyParseError extends Error {
  readonly input: string;
  readonly scale: Scale;

  constructor(message: string, input: string, scale: Scale) {
    super(message);
    this.name = 'MoneyParseError';
    this.input = input;
    this.scale = scale;
  }
}

/**
 * Strict decimal grammar. Deliberately narrower than `Number()`:
 *
 *   - no exponent form  — `1e2` as a money input is almost always a bug
 *   - no leading `+`    — one canonical spelling per value
 *   - no whitespace     — trim at the boundary, explicitly, if you want to
 *   - no `Infinity`, `NaN`, hex, octal, underscores, or empty string
 *   - at least one digit before the point
 *
 * `Number('')` is 0 and `Number(' 12 ')` is 12. Either of those reaching a ledger
 * silently is worse than a 400.
 */
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parse an exact decimal string into integer minor units at `scale`.
 *
 * Exact and total: there is no float anywhere in this function, so there is no
 * input for which the result is off by one minor unit.
 *
 * Extra fractional digits are **rejected**, never rounded. Rounding here would
 * mean the amount the user typed and the amount stored differ with nothing
 * recording that it happened; the caller must round explicitly and visibly.
 */
export function parseScaled(input: string, scale: Scale): bigint {
  if (typeof input !== 'string') {
    throw new MoneyParseError('amount must be a string, not a number', String(input), scale);
  }

  const m = DECIMAL.exec(input);
  if (!m) {
    throw new MoneyParseError('not an exact decimal literal', input, scale);
  }

  const [, signPart, intPart, fracPart = ''] = m as unknown as [string, string, string, string?];
  const frac = fracPart ?? '';

  if (frac.length > scale) {
    throw new MoneyParseError(
      `too many fractional digits: ${String(frac.length)} given, scale is ${String(scale)}`,
      input,
      scale,
    );
  }

  const padded = frac.padEnd(scale, '0');
  const magnitude = BigInt(intPart + padded);

  // `-0` and `-0.00` normalise to 0n. A signed zero in a ledger has no meaning
  // and would break equality checks against the unsigned zero.
  if (magnitude === 0n) return 0n;

  return signPart === '-' ? -magnitude : magnitude;
}

/**
 * Render integer minor units back to an exact decimal string, always with
 * exactly `scale` fractional digits.
 *
 * This is the *only* correct way out of a bigint amount. `Number(v) / 100`
 * destroys exactness above 2^53 minor units and introduces binary-fraction error
 * below it.
 */
export function formatScaled(value: bigint, scale: Scale): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');

  if (scale === 0) return (negative ? '-' : '') + digits;

  const cut = digits.length - scale;
  return `${negative ? '-' : ''}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

export const parseCash = (input: string): bigint => parseScaled(input, CASH_SCALE);
export const formatCash = (value: bigint): string => formatScaled(value, CASH_SCALE);

export const parseQuantity = (input: string): bigint => parseScaled(input, QUANTITY_SCALE);
export const formatQuantity = (value: bigint): string => formatScaled(value, QUANTITY_SCALE);
