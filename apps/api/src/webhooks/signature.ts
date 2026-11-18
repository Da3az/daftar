import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * # Webhook signature verification
 *
 * The scheme is modelled on Stripe's, which is the best-documented reference:
 * a header carrying a timestamp and one or more HMAC-SHA256 signatures over
 * `"{timestamp}.{raw body}"`.
 *
 *     X-Daftar-Signature: t=1763380800,v1=5257a8...,v1=0b1c2d...
 *
 * Four things matter, and each has been got wrong in production by someone:
 *
 * ## 1. The signature is over the RAW BYTES
 *
 * Not over a re-serialisation of the parsed body. A `JSON.parse` →
 * `JSON.stringify` round trip is not byte-preserving. Measured on Node 26:
 *
 * ```text
 * {"2":"x","1":"y"}             -> {"1":"y","2":"x"}        integer-like keys reorder
 * {"a":1.0}                     -> {"a":1}                  number formatting
 * {"a":1e2}                     -> {"a":100}
 * {"a":12345678901234567890}    -> {"a":12345678901234567000}  precision lost
 * { "a" : 1 }                   -> {"a":1}                  whitespace
 * {"a":"A"}                -> {"a":"A"}                unicode escaping
 * {"a":1,"a":2}                 -> {"a":2}                  duplicate keys
 * ```
 *
 * Note what is *not* on that list: ordinary string keys keep their insertion
 * order, so the usual "JSON.stringify reorders your keys" explanation is wrong
 * for the common case. The round trip breaks the HMAC for the six reasons above
 * instead — and the big-integer row is this project's own float hazard arriving
 * through the webhook door.
 *
 * Either way the failure presents as a wrong secret rather than a design error,
 * which is what makes it the most common webhook bug.
 *
 * Fastify discards the raw body once its JSON parser runs, so the route
 * installs its own content-type parser that keeps the buffer. See
 * `src/webhooks/raw-body.ts`.
 *
 * ## 2. Constant-time comparison
 *
 * `a === b` on strings short-circuits at the first differing byte, so the time
 * it takes leaks how many leading bytes were correct. That is enough to recover
 * a signature byte by byte. `crypto.timingSafeEqual` does not short-circuit.
 *
 * It also throws if the two buffers differ in length, which itself leaks — so
 * the length is checked first and a mismatch is reported without comparing.
 * That is safe here because the length of a hex SHA-256 is public knowledge.
 *
 * ## 3. A timestamp tolerance window
 *
 * A correct signature is valid forever without one, so an attacker who captures
 * one request can replay it indefinitely. The timestamp is inside the signed
 * payload — signing `"{t}.{body}"` rather than just the body — so it cannot be
 * altered without invalidating the signature.
 *
 * ## 4. Multiple signatures per header
 *
 * Providers send more than one `v1=` during secret rotation. Accepting the
 * request if **any** of them verifies is what makes a zero-downtime rotation
 * possible. Every candidate is compared, rather than returning on the first
 * match, so the work does not depend on their order.
 */

export const SIGNATURE_HEADER = 'x-daftar-signature';
export const SIGNATURE_SCHEME = 'v1';

/** Five minutes each way, the same default Stripe documents. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface ParsedSignatureHeader {
  timestamp: number;
  signatures: string[];
}

export class SignatureFormatError extends Error {
  constructor(detail: string) {
    super(`malformed ${SIGNATURE_HEADER}: ${detail}`);
    this.name = 'SignatureFormatError';
  }
}

/**
 * Parse `t=<unix seconds>,v1=<hex>[,v1=<hex>...]`.
 *
 * Unknown keys are ignored rather than rejected, so a provider adding a `v2=`
 * scheme does not break a verifier that only understands `v1`. Rejecting
 * unknown keys would make any future scheme addition a breaking change.
 */
export function parseSignatureHeader(header: string): ParsedSignatureHeader {
  if (typeof header !== 'string' || header.length === 0) {
    throw new SignatureFormatError('empty');
  }
  if (header.length > 4096) {
    // An unbounded header gets hashed and logged. Bound it.
    throw new SignatureFormatError('too long');
  }

  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;

    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();

    if (name === 't') {
      if (!/^\d{1,15}$/.test(value)) throw new SignatureFormatError('t is not a unix timestamp');
      timestamp = Number(value);
    } else if (name === SIGNATURE_SCHEME) {
      // 64 hex characters: SHA-256. Validated here so a malformed value is a
      // format error rather than a silent verification failure.
      if (!/^[0-9a-f]{64}$/i.test(value)) continue;
      signatures.push(value.toLowerCase());
    }
  }

  if (timestamp === undefined) throw new SignatureFormatError('missing t');
  if (signatures.length === 0) throw new SignatureFormatError(`no ${SIGNATURE_SCHEME} signature`);

  return { timestamp, signatures };
}

/** The signed payload: `"{timestamp}.{raw body}"`. */
export function signedPayload(timestamp: number, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${String(timestamp)}.`, 'utf8'), rawBody]);
}

/** Compute the expected signature. Also used by the signing script. */
export function computeSignature(secret: string, timestamp: number, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(signedPayload(timestamp, rawBody)).digest('hex');
}

/** SHA-256 of the raw bytes — the same bytes the signature covers. */
export function hashRawBody(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * Constant-time hex comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a timing
 * signal, so the length is compared first — safe, because the length of a hex
 * SHA-256 is not a secret.
 */
export function signaturesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');

  // A non-hex input yields a short buffer; a length check on the decoded form
  // catches that without throwing.
  if (left.length !== right.length || left.length === 0) return false;

  return timingSafeEqual(left, right);
}

export type VerificationResult =
  | { valid: true; timestamp: number; withinWindow: true; payloadHash: string }
  /** Correctly signed, but outside the tolerance window: a replay. */
  | { valid: true; timestamp: number; withinWindow: false; payloadHash: string; ageSeconds: number }
  | { valid: false; reason: 'bad_signature'; timestamp: number; payloadHash: string }
  | { valid: false; reason: 'malformed_header'; detail: string };

export interface VerifyOptions {
  secret: string;
  rawBody: Buffer;
  header: string;
  /** Unix seconds. Injected so tests can sit exactly on the boundary. */
  nowSeconds: number;
  toleranceSeconds?: number;
}

/**
 * Verify a webhook request.
 *
 * The order of checks is deliberate: **signature first, window second.**
 *
 * An unsigned or wrongly-signed request is rejected before its timestamp is
 * trusted for anything, because the timestamp is attacker-controlled until the
 * signature has vouched for it. Checking the window first would mean rejecting
 * on the basis of a value that has not been authenticated — and, worse, would
 * let an attacker choose which error they get.
 *
 * A valid signature with a stale timestamp returns `valid: true,
 * withinWindow: false` rather than a flat rejection. The caller needs the
 * distinction: a forgery is an attack, a stale replay is usually a provider
 * retrying, and they warrant different responses and different alerts.
 */
export function verify(options: VerifyOptions): VerificationResult {
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  let parsed: ParsedSignatureHeader;
  try {
    parsed = parseSignatureHeader(options.header);
  } catch (err) {
    return {
      valid: false,
      reason: 'malformed_header',
      detail: err instanceof SignatureFormatError ? err.message : 'unparseable',
    };
  }

  const payloadHash = hashRawBody(options.rawBody);
  const expected = computeSignature(options.secret, parsed.timestamp, options.rawBody);

  /**
   * Every candidate is compared, and the result is accumulated rather than
   * returned early. Returning on the first match would make the time taken
   * depend on which signature matched, reintroducing a (much weaker) timing
   * signal that the constant-time comparison was there to remove.
   */
  let matched = false;
  for (const candidate of parsed.signatures) {
    if (signaturesEqual(candidate, expected)) matched = true;
  }

  if (!matched) {
    return { valid: false, reason: 'bad_signature', timestamp: parsed.timestamp, payloadHash };
  }

  const age = options.nowSeconds - parsed.timestamp;

  /**
   * Absolute value, so a timestamp from the *future* is also out of window.
   * A one-sided check would let an attacker hold a captured request and replay
   * it indefinitely by pre-dating it — and would also mask real clock skew,
   * which is worth knowing about.
   *
   * `<=` so the boundary itself is inside the window. Tested at exactly
   * `tolerance` and at `tolerance + 1`, because off-by-one here is the kind of
   * thing that only shows up under clock skew in production.
   */
  if (Math.abs(age) <= tolerance) {
    return { valid: true, timestamp: parsed.timestamp, withinWindow: true, payloadHash };
  }

  return {
    valid: true,
    timestamp: parsed.timestamp,
    withinWindow: false,
    payloadHash,
    ageSeconds: age,
  };
}
