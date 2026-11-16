import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env.ts';

/**
 * The point of boot-time validation is that a bad value stops the process
 * instead of surfacing as a 500 on the one code path nobody exercised. These
 * tests exercise the schema directly, because the real `load()` calls
 * `process.exit(78)` and would take the test worker with it.
 */

const minimal = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' } as NodeJS.ProcessEnv;

describe('env validation', () => {
  it('requires DATABASE_URL with no default', () => {
    const result = parseEnv({});
    expect(result.success).toBe(false);

    const paths = result.error?.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('DATABASE_URL');
  });

  it('accepts a minimal environment and fills defaults', () => {
    const result = parseEnv(minimal);
    expect(result.success).toBe(true);

    const env = result.data!;
    expect(env.NODE_ENV).toBe('development');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.PORT).toBe(3000);
    expect(env.DB_POOL_MAX).toBe(10);
    expect(env.LEDGER_CONCURRENCY_MODE).toBe('serializable');
    expect(env.DAFTAR_NAIVE_OVERDRAFT).toBe(false);
    expect(env.DAFTAR_NAIVE_LOST_UPDATE).toBe(false);
  });

  it('HOST defaults to loopback, not 0.0.0.0', () => {
    // A service that binds every interface by default is one misconfigured
    // firewall away from being public. Caddy proxies to it; nothing else needs
    // to reach it.
    expect(parseEnv(minimal).data?.HOST).toBe('127.0.0.1');
  });

  describe('boolean parsing', () => {
    it.each([
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['yes', true],
      ['on', true],
      ['false', false],
      ['FALSE', false],
      ['0', false],
      ['no', false],
      ['off', false],
      ['', false],
      ['  true  ', true],
    ])('DAFTAR_NAIVE_OVERDRAFT=%j -> %s', (raw, expected) => {
      const result = parseEnv({ ...minimal, DAFTAR_NAIVE_OVERDRAFT: raw });
      expect(result.success).toBe(true);
      expect(result.data?.DAFTAR_NAIVE_OVERDRAFT).toBe(expected);
    });

    it('rejects a value that is neither, rather than coercing it', () => {
      // The whole reason this is not `Boolean(value)`: Boolean("false") is true,
      // so a naive flag spelled "False" would silently be ON.
      const result = parseEnv({ ...minimal, DAFTAR_NAIVE_OVERDRAFT: 'maybe' });
      expect(result.success).toBe(false);
    });

    it('Boolean() would have got this wrong, which is why it is not used', () => {
      expect(Boolean('false')).toBe(true);
      expect(
        parseEnv({ ...minimal, DAFTAR_NAIVE_OVERDRAFT: 'false' }).data?.DAFTAR_NAIVE_OVERDRAFT,
      ).toBe(false);
    });
  });

  describe('numbers', () => {
    it.each([
      ['PORT', '0'],
      ['PORT', '65536'],
      ['PORT', 'http'],
      ['PORT', '3000.5'],
      ['DB_POOL_MAX', '0'],
      ['DB_POOL_MAX', '-1'],
      ['DB_POOL_MAX', '501'],
      ['DB_POOL_CONNECTION_TIMEOUT_MS', '10'],
    ])('rejects %s=%j', (key, value) => {
      expect(parseEnv({ ...minimal, [key]: value }).success).toBe(false);
    });

    it('coerces a valid numeric string', () => {
      expect(parseEnv({ ...minimal, PORT: '8080' }).data?.PORT).toBe(8080);
    });

    it('allows DB_STATEMENT_TIMEOUT_MS=0, meaning no limit', () => {
      // Migrations and seed loads legitimately need this.
      const result = parseEnv({ ...minimal, DB_STATEMENT_TIMEOUT_MS: '0' });
      expect(result.success).toBe(true);
      expect(result.data?.DB_STATEMENT_TIMEOUT_MS).toBe(0);
    });
  });

  describe('enums', () => {
    it.each(['pessimistic', 'serializable', 'advisory'])(
      'accepts LEDGER_CONCURRENCY_MODE=%s',
      (mode) => {
        expect(
          parseEnv({ ...minimal, LEDGER_CONCURRENCY_MODE: mode }).data?.LEDGER_CONCURRENCY_MODE,
        ).toBe(mode);
      },
    );

    it('rejects an unknown concurrency mode', () => {
      // Silently defaulting here would mean a benchmark labelled "advisory" that
      // actually measured something else.
      expect(parseEnv({ ...minimal, LEDGER_CONCURRENCY_MODE: 'optimistic' }).success).toBe(false);
    });

    it('rejects an unknown NODE_ENV', () => {
      expect(parseEnv({ ...minimal, NODE_ENV: 'staging' }).success).toBe(false);
    });
  });

  describe('CORS_ORIGINS', () => {
    it('defaults to an empty allowlist, meaning same-origin only', () => {
      expect(parseEnv(minimal).data?.CORS_ORIGINS).toEqual([]);
    });

    it('splits, trims and drops empties', () => {
      const result = parseEnv({
        ...minimal,
        CORS_ORIGINS: 'http://a.test, http://b.test ,,  ',
      });
      expect(result.data?.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    });
  });

  it('reports every problem at once, not just the first', () => {
    // A deploy that fails three times in a row over three separate typos is a
    // worse experience than one failure listing all three.
    const result = parseEnv({ PORT: 'nope', LEDGER_CONCURRENCY_MODE: 'nope' });
    expect(result.success).toBe(false);
    expect(result.error!.issues.length).toBeGreaterThanOrEqual(3);
  });
});
