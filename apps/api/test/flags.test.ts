import { describe, expect, it } from 'vitest';
import {
  FLAG_HEADERS,
  FlagHeaderError,
  defaultFlags,
  describeFlags,
  resolveFlags,
} from '../src/flags.ts';

/**
 * `ALLOW_FLAG_HEADERS=true` in the test environment (see vitest.config.ts), so
 * the header path is live here. The production default is off.
 */

describe('resolveFlags', () => {
  it('falls back to the environment defaults with no headers', () => {
    expect(resolveFlags({})).toEqual(defaultFlags());
  });

  it('reads the concurrency mode from a header', () => {
    expect(resolveFlags({ [FLAG_HEADERS.concurrencyMode]: 'pessimistic' }).concurrencyMode).toBe(
      'pessimistic',
    );
    expect(resolveFlags({ [FLAG_HEADERS.concurrencyMode]: 'ADVISORY' }).concurrencyMode).toBe(
      'advisory',
    );
    expect(
      resolveFlags({ [FLAG_HEADERS.concurrencyMode]: '  serializable ' }).concurrencyMode,
    ).toBe('serializable');
  });

  it('reads the naive flags from headers', () => {
    expect(resolveFlags({ [FLAG_HEADERS.naiveOverdraft]: 'true' }).naiveOverdraft).toBe(true);
    expect(resolveFlags({ [FLAG_HEADERS.naiveLostUpdate]: '1' }).naiveLostUpdate).toBe(true);
    expect(resolveFlags({ [FLAG_HEADERS.naiveOverdraft]: '0' }).naiveOverdraft).toBe(false);
  });

  it('returns a fresh object each call', () => {
    // Two concurrent requests must not share a flags object: one mutating it
    // would change the other's ledger strategy mid-transaction.
    const a = resolveFlags({});
    const b = resolveFlags({});
    expect(a).not.toBe(b);
    expect(a).not.toBe(defaultFlags());
  });

  it('rejects an unknown concurrency mode rather than defaulting', () => {
    // A typo in a k6 script must not look like a passing run of the strategy you
    // thought you were measuring.
    expect(() => resolveFlags({ [FLAG_HEADERS.concurrencyMode]: 'optimistic' })).toThrow(
      FlagHeaderError,
    );
  });

  it('rejects a non-boolean naive flag', () => {
    expect(() => resolveFlags({ [FLAG_HEADERS.naiveOverdraft]: 'yes' })).toThrow(FlagHeaderError);
    expect(() => resolveFlags({ [FLAG_HEADERS.naiveOverdraft]: '' })).toThrow(FlagHeaderError);
  });

  it('rejects a repeated flag header', () => {
    // A repeated header arrives as an array. Taking the first element would let
    // a caller smuggle a second value past a proxy that only inspects one.
    expect(() => resolveFlags({ [FLAG_HEADERS.naiveOverdraft]: ['true', 'false'] })).toThrow(
      FlagHeaderError,
    );
    expect(() =>
      resolveFlags({ [FLAG_HEADERS.concurrencyMode]: ['advisory', 'pessimistic'] }),
    ).toThrow(FlagHeaderError);
  });

  it('names the offending header on the error', () => {
    try {
      resolveFlags({ [FLAG_HEADERS.concurrencyMode]: 'optimistic' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FlagHeaderError);
      expect((err as FlagHeaderError).header).toBe(FLAG_HEADERS.concurrencyMode);
      expect((err as FlagHeaderError).message).toContain('pessimistic, serializable, advisory');
    }
  });

  it('ignores unrelated headers', () => {
    expect(resolveFlags({ 'user-agent': 'k6/1.0', 'x-daftar-something-else': 'true' })).toEqual(
      defaultFlags(),
    );
  });

  it('the two naive flags are independent', () => {
    const both = resolveFlags({
      [FLAG_HEADERS.naiveOverdraft]: 'true',
      [FLAG_HEADERS.naiveLostUpdate]: 'true',
    });
    expect(both).toMatchObject({ naiveOverdraft: true, naiveLostUpdate: true });

    const one = resolveFlags({ [FLAG_HEADERS.naiveOverdraft]: 'true' });
    expect(one).toMatchObject({ naiveOverdraft: true, naiveLostUpdate: false });
  });
});

describe('describeFlags', () => {
  it('names the strategy alone when nothing is naive', () => {
    expect(
      describeFlags({
        concurrencyMode: 'advisory',
        naiveOverdraft: false,
        naiveLostUpdate: false,
        naiveIdempotency: false,
      }),
    ).toBe('advisory');
  });

  it('appends each active naive path, so a log line is unambiguous', () => {
    expect(
      describeFlags({
        concurrencyMode: 'pessimistic',
        naiveOverdraft: true,
        naiveLostUpdate: false,
        naiveIdempotency: false,
      }),
    ).toBe('pessimistic+naive_overdraft');

    expect(
      describeFlags({
        concurrencyMode: 'pessimistic',
        naiveOverdraft: true,
        naiveLostUpdate: true,
        naiveIdempotency: false,
      }),
    ).toBe('pessimistic+naive_overdraft+naive_lost_update');
  });
});
