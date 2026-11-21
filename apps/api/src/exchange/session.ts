import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * # Guest sessions
 *
 * A guest is identified by a cookie holding `<participant id>.<mac>`, where the
 * MAC is an HMAC-SHA256 of the id under a server secret.
 *
 * ## Stateless, and why that is enough here
 *
 * There is no sessions table. The cookie names a participant and proves the
 * server issued it; the participant row is the session. Nothing to expire,
 * nothing to clean up, and a restart logs nobody out.
 *
 * What that gives up is revocation: a cookie is valid for as long as the secret
 * is. For a guest account holding play money that is the right trade. It would
 * not be for anything a person could lose.
 *
 * ## Why the legacy "account picker" did not become this
 *
 * The legacy UI names the account it is looking at in the request, and the
 * server believes it — the README says so, and says that store is the thing to
 * delete if the project ever gained users. This is the replacement: the account
 * comes from a credential the server issued, never from the request body. No
 * exchange endpoint accepts an account id.
 */

export const GUEST_COOKIE = 'daftar_guest';

/** 30 days. The browser forgets the guest; the ledger never does. */
export const GUEST_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const GUEST_ID_PATTERN = /^guest-[0-9a-f]{16}$/;

const sign = (secret: string, participantExternalId: string): string =>
  createHmac('sha256', secret).update(`guest-session:${participantExternalId}`).digest('base64url');

export const issueGuestToken = (secret: string, participantExternalId: string): string =>
  `${participantExternalId}.${sign(secret, participantExternalId)}`;

/** The participant id the token vouches for, or `null`. */
export function verifyGuestToken(secret: string, token: string): string | null {
  const separator = token.indexOf('.');
  if (separator < 0) return null;

  const participantExternalId = token.slice(0, separator);
  const mac = token.slice(separator + 1);
  if (!GUEST_ID_PATTERN.test(participantExternalId)) return null;

  /*
   * Length-checked before `timingSafeEqual`, which throws on a length mismatch
   * rather than returning false.
   */
  const given = Buffer.from(mac, 'utf8');
  const expected = Buffer.from(sign(secret, participantExternalId), 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  return participantExternalId;
}

/**
 * Read one cookie out of a `Cookie` header.
 *
 * Hand-rolled rather than `@fastify/cookie`: this is the only cookie the server
 * reads, its value is base64url and hex with no escaping to undo, and a
 * dependency for one `split` is a dependency to keep patched.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

/**
 * The `Set-Cookie` value.
 *
 * - `HttpOnly` — script on the page cannot read it, so an XSS cannot lift the
 *   session.
 * - `SameSite=Lax` — not sent on a cross-site POST, which is the CSRF defence
 *   for the order endpoints. The API is same-origin with the UI in both
 *   development and production, so `Lax` costs nothing.
 * - `Secure` in production only, because development is plain HTTP on
 *   localhost.
 */
export function guestCookie(token: string, options: { secure: boolean; clear?: boolean }): string {
  return [
    `${GUEST_COOKIE}=${options.clear === true ? '' : token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(options.clear === true ? 0 : GUEST_COOKIE_MAX_AGE_SECONDS)}`,
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}
