import { describe, expect, it } from 'vitest';
import { abs, add, cmp, divRound, neg, notional, sub, sum } from './arithmetic.js';
import { parseCash, parseQuantity, formatCash } from './decimal.js';

describe('divRound', () => {
  it('rounds halves away from zero, symmetrically', () => {
    expect(divRound(5n, 2n)).toBe(3n); // 2.5 -> 3
    expect(divRound(-5n, 2n)).toBe(-3n); // -2.5 -> -3
    expect(divRound(7n, 2n)).toBe(4n); // 3.5 -> 4
    expect(divRound(-7n, 2n)).toBe(-4n);
  });

  it('rounds below the half down', () => {
    expect(divRound(4n, 3n)).toBe(1n); // 1.33 -> 1
    expect(divRound(-4n, 3n)).toBe(-1n);
    expect(divRound(5n, 3n)).toBe(2n); // 1.66 -> 2
  });

  it('is exact', () => {
    expect(divRound(10n, 5n)).toBe(2n);
    expect(divRound(0n, 7n)).toBe(0n);
  });

  it('handles a negative denominator', () => {
    expect(divRound(5n, -2n)).toBe(-3n);
    expect(divRound(-5n, -2n)).toBe(3n);
  });

  it('throws on division by zero rather than returning Infinity', () => {
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
  });

  it('symmetry is what keeps double-entry legs cancelling', () => {
    // Both legs of a transaction derive from one rounded notional, so the
    // property that matters is divRound(-n, d) === -divRound(n, d).
    for (const n of [1n, 5n, 7n, 999_999_999_999n, 123_456_789n]) {
      for (const d of [2n, 3n, 7n, 100_000_000n]) {
        expect(divRound(-n, d)).toBe(-divRound(n, d));
      }
    }
  });
});

describe('notional', () => {
  it('computes cash from quantity and a frozen price', () => {
    // 0.5 BTC at 95,432.17 = 47,716.085 -> 47,716.09 (half away from zero)
    const qty = parseQuantity('0.5');
    const price = parseCash('95432.17');
    expect(formatCash(notional(qty, price))).toBe('47716.09');
  });

  it('is exact at satoshi granularity', () => {
    // 1 satoshi at 95,432.17 = 0.0009543217 cash -> 0.00 at cash scale
    expect(notional(1n, parseCash('95432.17'))).toBe(0n);

    // 100 satoshi -> 0.095432 -> 0.10
    expect(formatCash(notional(100n, parseCash('95432.17')))).toBe('0.10');
  });

  it('whole units multiply cleanly', () => {
    expect(notional(parseQuantity('1'), parseCash('100.00'))).toBe(10_000n);
    expect(notional(parseQuantity('3'), parseCash('100.00'))).toBe(30_000n);
  });

  it('stays exact at magnitudes a double cannot hold', () => {
    // 1_000_000 units at 9,007,199,254.74 — product exceeds 2^53 by orders of
    // magnitude before the divide.
    const got = notional(parseQuantity('1000000'), parseCash('9007199254.74'));
    expect(formatCash(got)).toBe('9007199254740000.00');
  });

  it('returns bigint', () => {
    expect(typeof notional(parseQuantity('1'), parseCash('1.00'))).toBe('bigint');
  });

  it('sign follows the quantity', () => {
    const price = parseCash('100.00');
    expect(notional(parseQuantity('-1.5'), price)).toBe(-15_000n);
  });
});

describe('arithmetic helpers', () => {
  it('add and sub are plain bigint ops', () => {
    expect(add(100n, 50n)).toBe(150n);
    expect(sub(100n, 50n)).toBe(50n);
  });

  it('string concatenation is the bug these wrappers exist to avoid', () => {
    // This is what the pg driver hands you without the INT8 type parser.
    const asDriverStrings = '100' + '50';
    expect(asDriverStrings).toBe('10050');
    expect(add(100n, 50n)).toBe(150n);
    // 100x off, and nothing threw.
    expect(BigInt(asDriverStrings)).not.toBe(add(100n, 50n));
  });

  it('neg and abs', () => {
    expect(neg(5n)).toBe(-5n);
    expect(neg(-5n)).toBe(5n);
    expect(abs(-5n)).toBe(5n);
    expect(abs(5n)).toBe(5n);
  });

  it('sum seeds with 0n, not 0', () => {
    expect(sum([1n, 2n, 3n])).toBe(6n);
    expect(sum([])).toBe(0n);
    // The reason the helper exists: the natural hand-written version — a `0`
    // seed, which is what anyone types — throws "Cannot mix BigInt and other
    // types" at runtime. Better to throw than to coerce, but better still to have
    // one helper nobody can get wrong.
    const seed = 0 as unknown as bigint;
    expect(() => [1n, 2n].reduce((a, b) => a + b, seed)).toThrow(TypeError);
  });

  it('sum of a balanced double-entry transaction is zero', () => {
    const debit = -4_771_609n; // 47,716.09 out
    const credit = 4_771_609n; // 47,716.09 in
    expect(sum([debit, credit])).toBe(0n);
  });

  it('cmp', () => {
    expect(cmp(1n, 2n)).toBe(-1);
    expect(cmp(2n, 1n)).toBe(1);
    expect(cmp(2n, 2n)).toBe(0);
  });
});
