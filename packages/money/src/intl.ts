import { CASH_SCALE } from './scale.ts';
import { formatScaled } from './decimal.ts';

/**
 * Locales are an explicit, pinned allowlist — never a bare language tag and never
 * `navigator.language`.
 *
 * Why the `-u-nu-latn` suffix is not optional: on Node 26 / ICU, bare `ar-SA`
 * resolves its numbering system to `arab`, so the same code renders 1234.50 as
 * `١٬٢٣٤٫٥٠`. Default numbering systems are ICU-version dependent and have
 * changed between releases. A ledger's digits must not change shape because the
 * runtime was upgraded, so the numbering system is part of the pin.
 *
 * Verified by test in `intl.test.ts`, which asserts the resolved numbering system
 * rather than trusting this comment.
 */
export const SUPPORTED_LOCALES = ['en-US-u-nu-latn', 'ar-SA-u-nu-latn'] as const;

export type MoneyLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: MoneyLocale = 'en-US-u-nu-latn';

/**
 * `Intl.NumberFormat.prototype.format` accepts a decimal string and parses it
 * exactly — that is the whole reason this module exists. But its TypeScript
 * signature types the string parameter as `Intl.StringNumericLiteral`, a
 * template-literal type that only a *statically known* numeric literal satisfies.
 * A `string` computed at runtime can never be assignable to it.
 *
 * So the cast is unavoidable. It lives here, once, with its justification,
 * rather than at each call site: `formatScaled` is total and only ever returns
 * `-?\d+(\.\d+)?`, which is exactly the grammar the parameter type describes.
 */
const asNumericLiteral = (s: string): Intl.StringNumericLiteral => s as Intl.StringNumericLiteral;

/*
 * One formatter per (locale, currency). Constructing an Intl.NumberFormat is the
 * expensive part; formatting is cheap. A table rendering 500 rows should not build
 * 500 formatters.
 */
const cache = new Map<string, Intl.NumberFormat>();

function formatter(locale: MoneyLocale, currency: string | undefined): Intl.NumberFormat {
  const key = `${locale}|${currency ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const made = new Intl.NumberFormat(locale, {
    ...(currency === undefined ? {} : { style: 'currency' as const, currency }),
    minimumFractionDigits: CASH_SCALE,
    maximumFractionDigits: CASH_SCALE,
    // Explicit: grouping and sign display must not vary by ICU default either.
    useGrouping: true,
    signDisplay: 'auto',
  });
  cache.set(key, made);
  return made;
}

/**
 * Format cash minor units for display.
 *
 * The bigint is converted to an exact **decimal string** and that string is handed
 * to `Intl.NumberFormat.prototype.format`, which accepts and parses string input
 * exactly (Intl.NumberFormat v3). The value never becomes a JavaScript `number`,
 * so there is no magnitude at which this starts lying.
 *
 * Measured on Node 26, formatting 123456789012345678901234567890.12:
 *
 *   via string : 123,456,789,012,345,678,901,234,567,890.12
 *   via Number : 123,456,789,012,345,680,000,000,000,000.00
 *
 * The second is what `Number(balance) / 100` gets you. There is a test asserting
 * exactly this pair, so the claim is checked and not just written down.
 */
export function formatCashLocalised(
  value: bigint,
  options: { locale?: MoneyLocale; currency?: string } = {},
): string {
  const { locale = DEFAULT_LOCALE, currency } = options;
  return formatter(locale, currency).format(asNumericLiteral(formatScaled(value, CASH_SCALE)));
}

/**
 * `formatToParts` variant, for composing output in markup — e.g. rendering the
 * fractional digits at a smaller size, or aligning on the decimal separator in a
 * ledger column. Still string-in, so still exact.
 */
export function formatCashParts(
  value: bigint,
  options: { locale?: MoneyLocale; currency?: string } = {},
): Intl.NumberFormatPart[] {
  const { locale = DEFAULT_LOCALE, currency } = options;
  return formatter(locale, currency).formatToParts(
    asNumericLiteral(formatScaled(value, CASH_SCALE)),
  );
}
