import { describe, expect, it } from 'vitest';
import {
  MoneyParseError,
  formatCash,
  formatQuantity,
  formatScaled,
  parseCash,
  parseQuantity,
  parseScaled,
} from './decimal.ts';
import { CASH_SCALE, QUANTITY_SCALE } from './scale.ts';

describe('parseScaled', () => {
  it('returns a bigint, not a number', () => {
    // The runtime type is the assertion. A `: bigint` annotation would be
    // satisfied by a `number` that TypeScript was lied to about.
    expect(typeof parseCash('1.00')).toBe('bigint');
  });

  it('parses exactly at cash scale', () => {
    expect(parseCash('0.00')).toBe(0n);
    expect(parseCash('0.01')).toBe(1n);
    expect(parseCash('1')).toBe(100n);
    expect(parseCash('1.5')).toBe(150n);
    expect(parseCash('1.05')).toBe(105n);
    expect(parseCash('-1.05')).toBe(-105n);
    expect(parseCash('1234567.89')).toBe(123456789n);
  });

  it('parses exactly at quantity scale', () => {
    expect(parseQuantity('0.00000001')).toBe(1n);
    expect(parseQuantity('1')).toBe(100_000_000n);
    expect(parseQuantity('0.5')).toBe(50_000_000n);
  });

  it('is exact past Number.MAX_SAFE_INTEGER', () => {
    // 2^53 - 1 is 9007199254740991. One minor unit past it is where a float
    // representation starts quietly losing integers.
    const beyond = '90071992547409910.09';
    expect(parseCash(beyond)).toBe(9007199254740991009n);

    // Proof the float path is wrong, so the test documents the hazard rather than
    // just avoiding it.
    expect(BigInt(Math.round(Number(beyond) * 100))).not.toBe(9007199254740991009n);
  });

  it('normalises signed zero', () => {
    expect(parseCash('-0')).toBe(0n);
    expect(parseCash('-0.00')).toBe(0n);
    expect(Object.is(parseCash('-0.00'), 0n)).toBe(true);
  });

  it('rejects more fractional digits than the scale, rather than rounding', () => {
    expect(() => parseCash('1.005')).toThrow(MoneyParseError);
    expect(() => parseQuantity('0.000000001')).toThrow(MoneyParseError);
  });

  it.each([
    ['', 'empty string — Number("") is 0'],
    [' 12 ', 'whitespace — Number(" 12 ") is 12'],
    ['+1.00', 'leading plus — two spellings of one value'],
    ['1e2', 'exponent form'],
    ['0x10', 'hex — Number("0x10") is 16'],
    ['1_000', 'numeric separators'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['.5', 'no integer part'],
    ['1.', 'trailing point'],
    ['1,000.00', 'grouping separators'],
    ['--1', 'double sign'],
  ])('rejects %j (%s)', (input) => {
    expect(() => parseCash(input)).toThrow(MoneyParseError);
  });

  it('rejects a number argument even though TypeScript would catch it', () => {
    // JSON from an untrusted client is the realistic source. The runtime guard is
    // what actually stops it.
    expect(() => parseCash(1.0 as unknown as string)).toThrow(MoneyParseError);
  });

  it('carries the offending input on the error for logging', () => {
    try {
      parseCash('1.005');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MoneyParseError);
      const e = err as MoneyParseError;
      expect(e.input).toBe('1.005');
      expect(e.scale).toBe(CASH_SCALE);
    }
  });
});

describe('formatScaled', () => {
  it('round-trips every parsed value', () => {
    for (const s of ['0.00', '0.01', '1.00', '1.05', '-1.05', '1234567.89', '-0.01']) {
      expect(formatCash(parseCash(s))).toBe(parseCash(s) === 0n ? '0.00' : s);
    }
  });

  it('always emits exactly `scale` fractional digits', () => {
    expect(formatCash(0n)).toBe('0.00');
    expect(formatCash(1n)).toBe('0.01');
    expect(formatCash(10n)).toBe('0.10');
    expect(formatCash(100n)).toBe('1.00');
    expect(formatCash(-1n)).toBe('-0.01');
    expect(formatQuantity(1n)).toBe('0.00000001');
    expect(formatQuantity(100_000_000n)).toBe('1.00000000');
  });

  it('handles scale 0', () => {
    expect(formatScaled(5n, 0)).toBe('5');
    expect(formatScaled(-5n, 0)).toBe('-5');
  });

  it('is exact for values far beyond float range', () => {
    const v = 123456789012345678901234567890n;
    expect(formatCash(v)).toBe('1234567890123456789012345678.90');
  });

  it('scale constants are what the ledger assumes', () => {
    expect(CASH_SCALE).toBe(2);
    expect(QUANTITY_SCALE).toBe(8);
  });

  it('does not use Number anywhere on the way out', () => {
    // 2^63 - 1, the largest int8 PostgreSQL can hold. If any intermediate step
    // went through a double, the last digits would be wrong.
    expect(formatCash(9223372036854775807n)).toBe('92233720368547758.07');
    expect(parseScaled('92233720368547758.07', 2)).toBe(9223372036854775807n);
  });
});
