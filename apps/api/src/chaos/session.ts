import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * # Chaos session tokens
 *
 * ## Why there is a token at all
 *
 * `POST /v1/chaos/burst` makes the **server** open N concurrent transactions.
 * That is the whole point — a browser caps at 6 connections per origin on
 * HTTP/1.1 and runs one JavaScript thread, so a browser-generated "storm" is
 * not concurrent and would show the invariant holding under load that is not
 * load. But it also means the endpoint is a denial-of-service amplifier: one
 * cheap request turns into 200 database transactions.
 *
 * So it is gated. Three layers, because any one of them alone is bypassable:
 *
 * 1. **A short-lived token**, issued by `POST /v1/chaos/session`. Not a static
 *    key: a static key shipped in a JavaScript bundle is a public key with
 *    extra steps.
 * 2. **A rate limit** on both endpoints, much tighter than the global one.
 * 3. **Hard caps** on virtual users and duration, enforced server-side. A
 *    client-side cap is a suggestion.
 *
 * ## Stateless, by design
 *
 * The token is an HMAC over its own contents. No sessions table, so nothing to
 * clean up, nothing to look up on the request path, and a restart does not
 * invalidate a token mid-demo.
 *
 * The trade-off is that a token cannot be revoked before it expires. Acceptable
 * at a 15-minute lifetime for an endpoint whose worst case is already capped;
 * it would not be acceptable for anything that moved real money.
 */

/**
 * 15 minutes. Long enough to read the page and run several bursts, short enough
 * that a token scraped out of devtools is worthless by the time anyone finds it.
 */
export const TOKEN_TTL_SECONDS = 900;

/** Hard ceiling on concurrency, enforced here and not negotiable by the client. */
export const MAX_VIRTUAL_USERS = 200;

/** Hard ceiling on how many accounts a burst may spread over. */
export const MAX_ACCOUNT_SPREAD = 50;

export interface ChaosSession {
  /**
   * The per-session demo tenant prefix.
   *
   * **Every account a burst touches is namespaced under this.** Demo writes
   * must never mix with the seeded data the evidence files measure — a chaos
   * run that deliberately causes overdrafts on a measured account would corrupt
   * the dataset every benchmark number in this repo was taken against.
   */
  tenant: string;
  /** Unix seconds. */
  expiresAt: number;
}

export interface IssuedToken {
  token: string;
  session: ChaosSession;
}

/**
 * `demo-` prefixed and 12 hex characters of randomness.
 *
 * Random rather than sequential: a sequential tenant id tells a visitor how
 * many demo sessions have ever been created, and lets them address someone
 * else's tenant by guessing.
 */
function newTenant(): string {
  return `demo-${randomBytes(6).toString('hex')}`;
}

const sign = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url');

/**
 * Issue a token for a fresh demo tenant.
 *
 * Format is `<tenant>.<expiry>.<mac>` — readable, so a developer can see what
 * they hold, and tamper-evident, because the MAC covers both other fields.
 */
export function issue(secret: string, now = Date.now()): IssuedToken {
  const session: ChaosSession = {
    tenant: newTenant(),
    expiresAt: Math.floor(now / 1000) + TOKEN_TTL_SECONDS,
  };

  const payload = `${session.tenant}.${String(session.expiresAt)}`;
  return { token: `${payload}.${sign(secret, payload)}`, session };
}

export type VerifyResult =
  | { valid: true; session: ChaosSession }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/**
 * Verify a token.
 *
 * **Signature first, expiry second.** The expiry is a field inside the token,
 * so until the MAC has vouched for it the expiry is attacker-controlled and
 * checking it first would be checking a number the attacker chose.
 */
export function verify(secret: string, token: string, now = Date.now()): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };

  const [tenant, expiry, mac] = parts as [string, string, string];
  if (!/^demo-[0-9a-f]{12}$/.test(tenant) || !/^\d+$/.test(expiry)) {
    return { valid: false, reason: 'malformed' };
  }

  const expected = sign(secret, `${tenant}.${expiry}`);

  /*
   * Length-checked before `timingSafeEqual`, which throws on a length mismatch
   * rather than returning false. Both are base64url of a SHA-256, so unequal
   * lengths mean malformed input, not a near-miss.
   */
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'bad_signature' };
  }

  const expiresAt = Number(expiry);
  if (expiresAt * 1000 <= now) return { valid: false, reason: 'expired' };

  return { valid: true, session: { tenant, expiresAt } };
}

/** The cash account for a demo tenant. */
export const demoCashExternalId = (tenant: string, index: number): string =>
  `${tenant}:cash-${String(index).padStart(3, '0')}`;

/** The position account for a demo tenant's cash account. */
export const demoPositionExternalId = (cashExternalId: string, symbol: string): string =>
  `${cashExternalId}:${symbol}`;
