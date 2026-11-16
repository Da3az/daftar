import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, formatCashLocalised, formatCashParts } from './intl.js';
import { formatCash, parseCash } from './decimal.js';

describe('pinned numbering system', () => {
  it('every supported locale resolves to latn digits', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const resolved = new Intl.NumberFormat(locale).resolvedOptions().numberingSystem;
      expect(resolved, `${locale} must pin latn digits`).toBe('latn');
    }
  });

  it('documents why the -u-nu-latn suffix is not optional', () => {
    // This is the whole justification for the pin, asserted rather than asserted
    // in a comment: a bare ar-SA renders arabic-indic digits, so dropping the
    // suffix changes what every amount in the ledger looks like.
    const bare = new Intl.NumberFormat('ar-SA').resolvedOptions().numberingSystem;
    expect(bare).toBe('arab');
    expect(bare).not.toBe('latn');

    const pinned = new Intl.NumberFormat('ar-SA-u-nu-latn').resolvedOptions().numberingSystem;
    expect(pinned).toBe('latn');
  });
});

describe('formatCashLocalised', () => {
  it('formats via an exact decimal string, not a number', () => {
    const value = 12345678901234567890123456789012n; // 1.2345...e30 minor units

    expect(formatCashLocalised(value, { locale: 'en-US-u-nu-latn' })).toBe(
      '123,456,789,012,345,678,901,234,567,890.12',
    );
  });

  it('the Number() path is measurably wrong, in two different ways', () => {
    const value = 12345678901234567890123456789012n;
    const exact = formatCashLocalised(value, { locale: 'en-US-u-nu-latn' });
    expect(exact).toBe('123,456,789,012,345,678,901,234,567,890.12');

    const fmt = new Intl.NumberFormat('en-US-u-nu-latn', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    // Path A — `Number(balance) / 100`, the obvious thing to write in a React
    // component. Two roundings: bigint -> double, then a division.
    const viaDivision = fmt.format(Number(value) / 100);

    // Path B — hand Intl the decimal string's numeric value instead. One
    // rounding. Also wrong, and wrong by a *different* amount than path A.
    const viaNumberOfString = fmt.format(Number('123456789012345678901234567890.12'));

    expect(viaDivision).toBe('123,456,789,012,345,660,000,000,000,000.00');
    expect(viaNumberOfString).toBe('123,456,789,012,345,680,000,000,000,000.00');

    // The point: both differ from the truth, and they differ from each other, so
    // there is no "the float answer" to compare against — only a family of wrong
    // ones that depends on the order of operations.
    expect(viaDivision).not.toBe(exact);
    expect(viaNumberOfString).not.toBe(exact);
    expect(viaDivision).not.toBe(viaNumberOfString);

    // Both lose everything below the 17th significant digit: the real value ends
    // in ...567,890.12 and both float paths end in four zero groups.
    expect(exact.endsWith('567,890.12')).toBe(true);
    expect(viaDivision.endsWith(',000,000,000,000.00')).toBe(true);
    expect(viaNumberOfString.endsWith(',000,000,000,000.00')).toBe(true);
  });

  it('is exact at the top of int8, which is the real ceiling', () => {
    // 2^63 - 1 is the largest value PostgreSQL's bigint can store, so this is the
    // largest balance that can ever come back from the database.
    expect(formatCashLocalised(9223372036854775807n)).toBe('92,233,720,368,547,758.07');
  });

  it('small and negative values', () => {
    expect(formatCashLocalised(0n)).toBe('0.00');
    expect(formatCashLocalised(1n)).toBe('0.01');
    expect(formatCashLocalised(-1n)).toBe('-0.01');
    expect(formatCashLocalised(-123456n)).toBe('-1,234.56');
  });

  it('currency style', () => {
    expect(formatCashLocalised(123456n, { locale: 'en-US-u-nu-latn', currency: 'USD' })).toBe(
      '$1,234.56',
    );
  });

  it('ar-SA-u-nu-latn inserts a bidi mark before a negative sign', () => {
    // Not a defect — it is correct bidi handling — but it means a snapshot
    // comparison against "-1,234.56" fails on an RTL locale for a reason that has
    // nothing to do with the number. Recorded so nobody "fixes" it later.
    const out = formatCashLocalised(-123456n, { locale: 'ar-SA-u-nu-latn' });
    expect(out).toContain('‎');
    expect(out.replace(/‎/g, '')).toBe('-1,234.56');
  });

  it('default locale is explicit, not host-derived', () => {
    expect(DEFAULT_LOCALE).toBe('en-US-u-nu-latn');
    expect(formatCashLocalised(123456n)).toBe(
      formatCashLocalised(123456n, { locale: DEFAULT_LOCALE }),
    );
  });

  it('reuses the cached formatter for repeated calls', () => {
    // A 500-row ledger table must not construct 500 formatters. Asserting the
    // observable consequence (identical output, no throw) plus a crude timing
    // sanity check would be flaky, so this just pins the contract that repeated
    // calls agree.
    const first = formatCashLocalised(123456n, { currency: 'USD' });
    const second = formatCashLocalised(123456n, { currency: 'USD' });
    expect(second).toBe(first);
  });
});

describe('formatCashParts', () => {
  it('exposes parts for decimal-aligned ledger columns', () => {
    const parts = formatCashParts(123456789n, { locale: 'en-US-u-nu-latn' });
    const byType = parts.map((p) => `${p.type}:${p.value}`);

    expect(byType).toEqual([
      'integer:1',
      'group:,',
      'integer:234',
      'group:,',
      'integer:567',
      'decimal:.',
      'fraction:89',
    ]);
  });

  it('parts reassemble into the formatted string', () => {
    const value = parseCash('98765432.10');
    const joined = formatCashParts(value)
      .map((p) => p.value)
      .join('');
    expect(joined).toBe(formatCashLocalised(value));
    expect(joined.replace(/,/g, '')).toBe(formatCash(value));
  });
});
