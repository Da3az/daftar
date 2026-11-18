import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  DEFAULT_TOLERANCE_SECONDS,
  SignatureFormatError,
  computeSignature,
  hashRawBody,
  parseSignatureHeader,
  signaturesEqual,
  signedPayload,
  verify,
} from '../src/webhooks/signature.ts';

/**
 * No database needed: this is pure crypto and parsing. The boundary tests are
 * the point of the file — an off-by-one in a replay window only shows up under
 * clock skew in production, which is the worst possible time to find it.
 */

const SECRET = 'whsec_test_do_not_use_in_production';
const NOW = 1_763_380_800; // a fixed instant, so nothing here depends on the clock

const body = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');

const header = (timestamp: number, signature: string): string =>
  `t=${String(timestamp)},v1=${signature}`;

const signedHeader = (timestamp: number, raw: Buffer, secret = SECRET): string =>
  header(timestamp, computeSignature(secret, timestamp, raw));

describe('the signed payload is timestamp + raw bytes', () => {
  it('is exactly `{timestamp}.{body}`', () => {
    const raw = Buffer.from('{"a":1}', 'utf8');
    expect(signedPayload(123, raw).toString('utf8')).toBe('123.{"a":1}');
  });

  it('includes the timestamp, so it cannot be altered without breaking the signature', () => {
    const raw = body({ amount: '100.00' });
    const a = computeSignature(SECRET, NOW, raw);
    const b = computeSignature(SECRET, NOW + 1, raw);

    // Same body, different timestamp, different signature. That is what makes
    // the replay window enforceable at all.
    expect(a).not.toBe(b);
  });

  it('matches a hand-rolled HMAC, so the scheme is reproducible by a stranger', () => {
    const raw = body({ id: 'evt_1' });
    const expected = createHmac('sha256', SECRET)
      .update(`${String(NOW)}.${raw.toString('utf8')}`)
      .digest('hex');

    expect(computeSignature(SECRET, NOW, raw)).toBe(expected);
  });
});

describe('the signature covers raw bytes, not a re-serialisation', () => {
  it('the same JSON value in different bytes gets a different signature', () => {
    // Same value, different bytes. A verifier that re-serialised would compute
    // one signature for both and fail against whichever was actually sent.
    const a = Buffer.from('{"a":1,"b":2}', 'utf8');
    const b = Buffer.from('{"b":2,"a":1}', 'utf8');

    expect(computeSignature(SECRET, NOW, a)).not.toBe(computeSignature(SECRET, NOW, b));
  });

  it('documents exactly what a JSON round trip does and does not change', () => {
    /**
     * Written as a table because the usual explanation — "JSON.stringify
     * reorders your keys" — is **wrong** for the common case, and a false
     * reason for a real rule is worse than no reason. Ordinary string keys keep
     * their insertion order. These six things are what actually break the HMAC.
     */
    const roundTrip = (s: string): string => JSON.stringify(JSON.parse(s));

    // Unchanged: ordinary string keys keep insertion order.
    expect(roundTrip('{"b":2,"a":1}')).toBe('{"b":2,"a":1}');

    // Changed:
    expect(roundTrip('{"2":"x","1":"y"}')).toBe('{"1":"y","2":"x"}'); // integer-like keys reorder
    expect(roundTrip('{"a":1.0}')).toBe('{"a":1}'); // number formatting
    expect(roundTrip('{"a":1e2}')).toBe('{"a":100}');
    expect(roundTrip('{ "a" : 1 }')).toBe('{"a":1}'); // whitespace
    expect(roundTrip('{"a":"\\u0041"}')).toBe('{"a":"A"}'); // unicode escaping
    expect(roundTrip('{"a":1,"a":2}')).toBe('{"a":2}'); // duplicate keys

    // And this project's own float hazard, arriving through the webhook door:
    // a JSON number is a double, so a large integer in a payload is corrupted
    // by the parse itself — before any signature check could help.
    expect(roundTrip('{"a":12345678901234567890}')).toBe('{"a":12345678901234567000}');
  });

  it('whitespace changes the signature', () => {
    const compact = Buffer.from('{"a":1}', 'utf8');
    const spaced = Buffer.from('{ "a": 1 }', 'utf8');

    expect(computeSignature(SECRET, NOW, compact)).not.toBe(computeSignature(SECRET, NOW, spaced));
  });

  it('a round trip through JSON.parse/stringify breaks verification', () => {
    // Exactly what happens if the route lets Fastify parse the body first.
    const original = Buffer.from('{"amount":1.0,"id":"evt_1"}', 'utf8');
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(original.toString())), 'utf8');

    // 1.0 became 1.
    expect(reserialised.toString()).toBe('{"amount":1,"id":"evt_1"}');

    const result = verify({
      secret: SECRET,
      rawBody: reserialised,
      header: signedHeader(NOW, original),
      nowSeconds: NOW,
    });

    expect(result).toMatchObject({ valid: false, reason: 'bad_signature' });
  });

  it('the payload hash is over the raw bytes too', () => {
    const raw = Buffer.from('{ "a" : 1.0 }', 'utf8');
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString())), 'utf8');

    // Different fingerprints, which is correct: they are different bytes, and
    // the hash exists to identify what was signed.
    expect(hashRawBody(raw)).not.toBe(hashRawBody(reserialised));
    expect(hashRawBody(raw)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseSignatureHeader', () => {
  it('parses a timestamp and one signature', () => {
    const sig = 'a'.repeat(64);
    expect(parseSignatureHeader(`t=${String(NOW)},v1=${sig}`)).toEqual({
      timestamp: NOW,
      signatures: [sig],
    });
  });

  it('parses several signatures, which is what makes secret rotation possible', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(parseSignatureHeader(`t=1,v1=${a},v1=${b}`).signatures).toEqual([a, b]);
  });

  it('ignores unknown keys so a future scheme is not a breaking change', () => {
    const sig = 'c'.repeat(64);
    const parsed = parseSignatureHeader(`t=1,v0=legacy,v1=${sig},v2=${'d'.repeat(64)}`);
    expect(parsed.signatures).toEqual([sig]);
  });

  it('lowercases hex so a provider sending uppercase still verifies', () => {
    const sig = 'A'.repeat(64);
    expect(parseSignatureHeader(`t=1,v1=${sig}`).signatures).toEqual(['a'.repeat(64)]);
  });

  it('tolerates whitespace around values', () => {
    const sig = 'e'.repeat(64);
    expect(parseSignatureHeader(` t = 1 , v1 = ${sig} `)).toEqual({
      timestamp: 1,
      signatures: [sig],
    });
  });

  it.each([
    ['', 'empty'],
    ['v1=' + 'a'.repeat(64), 'missing t'],
    [`t=${String(NOW)}`, 'no signature'],
    ['t=notanumber,v1=' + 'a'.repeat(64), 'non-numeric t'],
    [`t=${String(NOW)},v1=tooshort`, 'signature not 64 hex'],
    [`t=${String(NOW)},v1=${'z'.repeat(64)}`, 'signature not hex'],
  ])('rejects %j (%s)', (raw) => {
    expect(() => parseSignatureHeader(raw)).toThrow(SignatureFormatError);
  });

  it('rejects an over-long header rather than hashing and logging it', () => {
    expect(() => parseSignatureHeader(`t=1,v1=${'a'.repeat(5000)}`)).toThrow(SignatureFormatError);
  });
});

describe('signaturesEqual is constant-time and total', () => {
  it('matches identical hex', () => {
    expect(signaturesEqual('ab'.repeat(32), 'ab'.repeat(32))).toBe(true);
  });

  it('rejects a difference in the last byte', () => {
    const a = 'ab'.repeat(32);
    const b = `${a.slice(0, -1)}c`;
    expect(signaturesEqual(a, b)).toBe(false);
  });

  it('rejects a difference in the FIRST byte without throwing', () => {
    // The case a naive `timingSafeEqual` wrapper gets right and a `===` gets
    // wrong for the wrong reason — it is fast precisely because it leaks.
    const a = 'ab'.repeat(32);
    const b = `cb${a.slice(2)}`;
    expect(signaturesEqual(a, b)).toBe(false);
  });

  it('returns false on a length mismatch instead of throwing', () => {
    // crypto.timingSafeEqual throws on unequal lengths. Letting that escape
    // would turn a malformed signature into a 500.
    expect(signaturesEqual('ab', 'abcd')).toBe(false);
    expect(signaturesEqual('', '')).toBe(false);
  });

  it('returns false for non-hex input of the right length', () => {
    expect(signaturesEqual('z'.repeat(64), 'a'.repeat(64))).toBe(false);
  });
});

describe('verify — signature correctness', () => {
  const raw = body({ id: 'evt_1', amount: '100.00' });

  it('accepts a correctly signed, fresh request', () => {
    const result = verify({
      secret: SECRET,
      rawBody: raw,
      header: signedHeader(NOW, raw),
      nowSeconds: NOW,
    });

    expect(result).toMatchObject({ valid: true, withinWindow: true, timestamp: NOW });
  });

  it('rejects a signature made with a different secret', () => {
    const result = verify({
      secret: SECRET,
      rawBody: raw,
      header: signedHeader(NOW, raw, 'whsec_wrong'),
      nowSeconds: NOW,
    });

    expect(result).toMatchObject({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a tampered body', () => {
    const header_ = signedHeader(NOW, raw);
    const tampered = body({ id: 'evt_1', amount: '999999.00' });

    expect(
      verify({ secret: SECRET, rawBody: tampered, header: header_, nowSeconds: NOW }),
    ).toMatchObject({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a tampered timestamp, because the timestamp is signed', () => {
    const real = computeSignature(SECRET, NOW, raw);
    // An attacker moves the clock forward to escape the window check, keeping
    // the captured signature.
    const forged = header(NOW + 10_000, real);

    expect(
      verify({ secret: SECRET, rawBody: raw, header: forged, nowSeconds: NOW + 10_000 }),
    ).toMatchObject({ valid: false, reason: 'bad_signature' });
  });

  it('accepts when ANY of several signatures matches — secret rotation', () => {
    const oldSig = computeSignature('whsec_old', NOW, raw);
    const newSig = computeSignature(SECRET, NOW, raw);

    const result = verify({
      secret: SECRET,
      rawBody: raw,
      header: `t=${String(NOW)},v1=${oldSig},v1=${newSig}`,
      nowSeconds: NOW,
    });

    expect(result).toMatchObject({ valid: true, withinWindow: true });
  });

  it('reports a malformed header distinctly from a bad signature', () => {
    const result = verify({
      secret: SECRET,
      rawBody: raw,
      header: 'garbage',
      nowSeconds: NOW,
    });

    expect(result).toMatchObject({ valid: false, reason: 'malformed_header' });
  });

  it('an empty body is signable and verifiable', () => {
    const empty = Buffer.alloc(0);
    expect(
      verify({
        secret: SECRET,
        rawBody: empty,
        header: signedHeader(NOW, empty),
        nowSeconds: NOW,
      }),
    ).toMatchObject({ valid: true });
  });
});

describe('verify — the replay window, tested at the boundary', () => {
  const raw = body({ id: 'evt_boundary' });
  const T = DEFAULT_TOLERANCE_SECONDS;

  const at = (ageSeconds: number) =>
    verify({
      secret: SECRET,
      rawBody: raw,
      header: signedHeader(NOW - ageSeconds, raw),
      nowSeconds: NOW,
    });

  it('accepts at exactly the tolerance', () => {
    expect(at(T)).toMatchObject({ valid: true, withinWindow: true });
  });

  it('rejects the window at tolerance + 1', () => {
    // The off-by-one that only shows up under clock skew.
    expect(at(T + 1)).toMatchObject({ valid: true, withinWindow: false, ageSeconds: T + 1 });
  });

  it('accepts at tolerance - 1', () => {
    expect(at(T - 1)).toMatchObject({ valid: true, withinWindow: true });
  });

  it('a stale request is VALID but out of window, and the distinction matters', () => {
    const stale = at(T + 3600);

    // Correctly signed: this is a replay, not a forgery. A provider retrying an
    // hour later looks exactly like this, and it warrants a different response
    // and a different alert than a bad signature.
    expect(stale).toMatchObject({ valid: true, withinWindow: false });
    if (stale.valid) expect(stale.withinWindow).toBe(false);
  });

  it('treats a FUTURE timestamp as out of window too', () => {
    /**
     * The window is `Math.abs(age) <= tolerance`. A one-sided check would let an
     * attacker pre-date a captured request and replay it indefinitely — and
     * would hide real clock skew, which is worth knowing about.
     */
    const future = verify({
      secret: SECRET,
      rawBody: raw,
      header: signedHeader(NOW + T + 1, raw),
      nowSeconds: NOW,
    });

    expect(future).toMatchObject({ valid: true, withinWindow: false, ageSeconds: -(T + 1) });
  });

  it('accepts a timestamp exactly `tolerance` in the future', () => {
    expect(
      verify({
        secret: SECRET,
        rawBody: raw,
        header: signedHeader(NOW + T, raw),
        nowSeconds: NOW,
      }),
    ).toMatchObject({ valid: true, withinWindow: true });
  });

  it('honours a custom tolerance', () => {
    const header_ = signedHeader(NOW - 10, raw);

    expect(
      verify({
        secret: SECRET,
        rawBody: raw,
        header: header_,
        nowSeconds: NOW,
        toleranceSeconds: 5,
      }),
    ).toMatchObject({ withinWindow: false });

    expect(
      verify({
        secret: SECRET,
        rawBody: raw,
        header: header_,
        nowSeconds: NOW,
        toleranceSeconds: 30,
      }),
    ).toMatchObject({ withinWindow: true });
  });

  it('checks the signature BEFORE the window', () => {
    /**
     * Order matters. The timestamp is attacker-controlled until the signature
     * has vouched for it, so a stale *and* wrongly-signed request must report
     * the signature failure — not the window — or an attacker gets to choose
     * which error they receive, and the server has acted on an unauthenticated
     * value.
     */
    const result = verify({
      secret: SECRET,
      rawBody: raw,
      header: signedHeader(NOW - 99_999, raw, 'whsec_wrong'),
      nowSeconds: NOW,
    });

    expect(result).toMatchObject({ valid: false, reason: 'bad_signature' });
  });
});
