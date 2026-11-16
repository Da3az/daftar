import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { formatCash, parseCash } from '@daftar/money';
import { useTestDatabase } from './support/test-database.ts';
import { INT8_ARRAY_OID, INT8_OID, isBigIntTypeParserRegistered } from '../src/db/bigint.ts';
import { TIMESTAMPTZ_OID, normaliseTimestamp } from '../src/db/timestamps.ts';

/**
 * The contract this file defends: **an int8 column read through this driver is a
 * JavaScript `bigint`, at runtime, for every magnitude PostgreSQL can store.**
 *
 * It is tested against a real server rather than asserted in a type, because the
 * failure mode is entirely a runtime one. A `balance: bigint` annotation is
 * satisfied by a string the compiler was told about incorrectly, and that string
 * then concatenates instead of adding.
 */
const ctx = useTestDatabase();

/** 2^63 - 1 and -2^63: the exact bounds of PostgreSQL's bigint. */
const INT8_MAX = 9223372036854775807n;
const INT8_MIN = -9223372036854775808n;

describe('int8 arrives as bigint', () => {
  it('registers the parser exactly once', () => {
    expect(isBigIntTypeParserRegistered()).toBe(true);
    expect(INT8_OID).toBe(20);
    expect(INT8_ARRAY_OID).toBe(1016);
  });

  it('a scalar int8 is a bigint, not a string', async () => {
    const { rows } = await ctx.pool.query<{ v: bigint }>('SELECT 100::bigint AS v');

    // The runtime type IS the assertion.
    expect(typeof rows[0]?.v).toBe('bigint');
    expect(rows[0]?.v).toBe(100n);
  });

  it('adding two values from the database adds, rather than concatenating', async () => {
    const { rows } = await ctx.pool.query<{ a: bigint; b: bigint }>(
      'SELECT 100::bigint AS a, 50::bigint AS b',
    );
    const a = rows[0]!.a;
    const b = rows[0]!.b;

    expect(a + b).toBe(150n);

    // The bug, spelled out: without the type parser both would be strings and
    // this is what the same expression would produce.
    expect(`${String(a)}${String(b)}`).toBe('10050');
  });

  it('is exact at both int8 bounds', async () => {
    const { rows } = await ctx.pool.query<{ hi: bigint; lo: bigint }>(
      'SELECT $1::bigint AS hi, $2::bigint AS lo',
      [INT8_MAX.toString(), INT8_MIN.toString()],
    );

    expect(rows[0]?.hi).toBe(INT8_MAX);
    expect(rows[0]?.lo).toBe(INT8_MIN);

    // Both bounds are far outside the range a double represents exactly, so the
    // lossy path is visibly wrong rather than merely theoretically so.
    expect(BigInt(Number(INT8_MAX))).not.toBe(INT8_MAX);
  });

  it('COUNT(*) is a bigint too, which is correct and easy to trip over', async () => {
    await ctx.pool.query(
      `INSERT INTO accounts (external_id, kind) VALUES ('count-a', 'customer_cash'), ('count-b', 'customer_cash')`,
    );

    const { rows } = await ctx.pool.query<{ n: bigint }>('SELECT count(*) AS n FROM accounts');

    expect(typeof rows[0]?.n).toBe('bigint');
    expect(rows[0]?.n).toBe(2n);
    // Worth stating once: the obvious comparison is false.
    expect((rows[0]?.n as unknown) === 2).toBe(false);
  });

  it('int8[] elements are bigints, including NULLs', async () => {
    const { rows } = await ctx.pool.query<{ v: (bigint | null)[] }>(
      `SELECT ARRAY[1, 2, NULL, ${INT8_MAX.toString()}]::bigint[] AS v`,
    );

    expect(rows[0]?.v).toEqual([1n, 2n, null, INT8_MAX]);
    expect(typeof rows[0]?.v[0]).toBe('bigint');
  });

  it('a bigint round-trips through a real column unchanged', async () => {
    const stored = parseCash('92233720368547758.07'); // = INT8_MAX minor units

    await ctx.pool.query(
      `INSERT INTO accounts (external_id, kind, balance) VALUES ('roundtrip', 'customer_cash', $1)`,
      [stored.toString()],
    );

    const { rows } = await ctx.pool.query<{ balance: bigint }>(
      `SELECT balance FROM accounts WHERE external_id = 'roundtrip'`,
    );

    expect(rows[0]?.balance).toBe(stored);
    expect(rows[0]?.balance).toBe(INT8_MAX);
    expect(formatCash(rows[0]!.balance)).toBe('92233720368547758.07');
  });

  it('the parser is not registered for int4, which is not money', async () => {
    const { rows } = await ctx.pool.query<{ v: number }>('SELECT 42::int AS v');
    expect(typeof rows[0]?.v).toBe('number');
    expect(rows[0]?.v).toBe(42);
  });

  it('numeric is still a string — there is no lossless primitive for it', async () => {
    const { rows } = await ctx.pool.query<{ v: string }>(
      `SELECT 1.000000000000000000000001::numeric AS v`,
    );
    expect(typeof rows[0]?.v).toBe('string');
    expect(rows[0]?.v).toBe('1.000000000000000000000001');
  });

  it('the schema contains no numeric or float column, so that stays true', async () => {
    const { rows } = await ctx.pool.query<{ table_name: string; column_name: string; t: string }>(
      `SELECT table_name, column_name, data_type AS t
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('numeric', 'real', 'double precision', 'money')`,
    );

    // A float column holding an amount is the bug this repo opens by ruling out.
    // Asserting on the catalogue means adding one is a failing test, not a code
    // review someone has to catch.
    expect(rows).toEqual([]);
  });

  it('every money column in the schema is bigint', async () => {
    const { rows } = await ctx.pool.query<{ column_name: string; t: string }>(
      `SELECT column_name, data_type AS t
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'accounts'
          AND column_name IN ('id', 'balance')
        ORDER BY column_name`,
    );

    expect(rows).toEqual([
      { column_name: 'balance', t: 'bigint' },
      { column_name: 'id', t: 'bigint' },
    ]);
  });
});

describe('timestamps keep microsecond precision', () => {
  it('a timestamptz is an exact RFC 3339 string, not a Date', async () => {
    const { rows } = await ctx.pool.query<{ t: string }>(
      `SELECT '2026-01-02 03:04:05.123456+00'::timestamptz AS t`,
    );

    expect(typeof rows[0]?.t).toBe('string');
    // All six fractional digits survive.
    expect(rows[0]?.t).toBe('2026-01-02T03:04:05.123456Z');
  });

  it('the Date path loses the last three digits — the hazard, measured', async () => {
    const client = new pg.Client({
      connectionString: ctx.url,
      application_name: 'daftar-test-date-parser',
    });
    await client.connect();

    try {
      // pg's default: parse timestamptz into a JavaScript Date.
      client.setTypeParser(TIMESTAMPTZ_OID, (value: string) => new Date(value));

      const { rows } = await client.query<{ t: Date }>(
        `SELECT '2026-01-02 03:04:05.123456+00'::timestamptz AS t`,
      );

      expect(rows[0]?.t).toBeInstanceOf(Date);
      // .456 of a millisecond is simply gone: a Date holds milliseconds.
      expect(rows[0]?.t.toISOString()).toBe('2026-01-02T03:04:05.123Z');
      expect(rows[0]?.t.getMilliseconds()).toBe(123);
    } finally {
      await client.end();
    }
  });

  it('two rows 400 microseconds apart stay distinct, so ordering has no false ties', async () => {
    /**
     * This is why the precision matters rather than being pedantry. Phase 6's
     * statement orders by `(created_at, id)` and computes a running balance over
     * that order. Truncating to milliseconds would make these two rows compare
     * equal — a tie the data does not contain — and a tie in a ledger's ordering
     * is a non-deterministic running balance.
     */
    const { rows } = await ctx.pool.query<{ a: string; b: string }>(
      `SELECT '2026-01-02 03:04:05.123456+00'::timestamptz AS a,
              '2026-01-02 03:04:05.123856+00'::timestamptz AS b`,
    );

    expect(rows[0]?.a).not.toBe(rows[0]?.b);

    // Whereas through a Date they would be the same instant.
    expect(new Date(rows[0]!.a).getTime()).toBe(new Date(rows[0]!.b).getTime());
  });

  it('normalises PostgreSQL ISO output to RFC 3339 without touching digits', () => {
    expect(normaliseTimestamp('2026-01-02 03:04:05.123456+00')).toBe('2026-01-02T03:04:05.123456Z');
    expect(normaliseTimestamp('2026-01-02 03:04:05+00')).toBe('2026-01-02T03:04:05Z');
    expect(normaliseTimestamp('2026-01-02 03:04:05.123456+05:30')).toBe(
      '2026-01-02T03:04:05.123456+05:30',
    );
    expect(normaliseTimestamp('2026-01-02 03:04:05.123456-05')).toBe(
      '2026-01-02T03:04:05.123456-05:00',
    );
    // A timestamp with no zone stays zoneless rather than acquiring a false one.
    expect(normaliseTimestamp('2026-01-02 03:04:05.123456')).toBe('2026-01-02T03:04:05.123456');
    // PostgreSQL's out-of-range sentinels are not timestamps and pass through.
    expect(normaliseTimestamp('infinity')).toBe('infinity');
    expect(normaliseTimestamp('-infinity')).toBe('-infinity');
  });

  it('the result parses with Date.parse, so a client is not forced to hand-roll', () => {
    const value = normaliseTimestamp('2026-01-02 03:04:05.123456+00');
    expect(Number.isNaN(Date.parse(value))).toBe(false);
  });

  it('the server runs in UTC, so offsets are stable across evidence files', async () => {
    const { rows } = await ctx.pool.query<{ tz: string }>(
      `SELECT current_setting('TimeZone') AS tz`,
    );
    expect(rows[0]?.tz).toBe('UTC');
  });

  it('every temporal column in the schema is timestamptz, never a bare timestamp', async () => {
    // A bare `timestamp` is ambiguous the moment two processes in different
    // zones write to it. Asserted on the catalogue so adding one fails here.
    const { rows } = await ctx.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('timestamp without time zone', 'time without time zone')`,
    );

    expect(rows).toEqual([]);
  });
});

describe('the baseline this protects against', () => {
  it('a client with the default parsers returns int8 as a string', async () => {
    /**
     * Proof the parser is doing real work rather than agreeing with a default.
     *
     * The global registry must not be touched to get this: that registry is
     * exactly the module-level state `db/bigint.ts` configures, so unsetting it
     * here would break every other test in this process. `pg.Client` has a
     * per-client override map — `client.setTypeParser` writes to it and
     * `getTypeParser` consults it before the global.
     *
     * Note that `new pg.TypeOverrides()` with no argument is *not* a pristine
     * registry. Reading `pg/lib/type-overrides.js`, its constructor falls back
     * to the shared `pg-types` module when given no `userTypes`, so it would
     * inherit the BigInt parser and this test would assert nothing.
     */
    const client = new pg.Client({
      connectionString: ctx.url,
      application_name: 'daftar-test-default-parsers',
    });
    await client.connect();

    // pg's own default for int8: hand back the text form unchanged.
    client.setTypeParser(INT8_OID, (value: string) => value);

    try {
      const { rows } = await client.query<{ a: string; b: string }>(
        'SELECT 100::bigint AS a, 50::bigint AS b',
      );

      expect(typeof rows[0]?.a).toBe('string');
      expect(rows[0]?.a).toBe('100');

      // And here is the 100x error, with nothing thrown. Note that `+` on two
      // values the compiler agrees are strings is not even suspicious-looking —
      // which is the whole problem.
      const concatenated = rows[0]!.a + rows[0]!.b;
      expect(concatenated).toBe('10050');
      expect(BigInt(concatenated)).not.toBe(150n);
    } finally {
      await client.end();
    }
  });
});
