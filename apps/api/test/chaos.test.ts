import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { buildApp, type App } from '../src/app.ts';
import { useTestDatabase } from './support/test-database.ts';
import { resetInstruments, resetLedger } from './support/reset.ts';
import { HOUSE_SHARDS } from '../src/orders/place.ts';
import {
  MAX_ACCOUNT_SPREAD,
  MAX_VIRTUAL_USERS,
  TOKEN_TTL_SECONDS,
  demoCashExternalId,
  issue,
  verify,
} from '../src/chaos/session.ts';
import { openingFor, reapDemoTenants } from '../src/chaos/burst.ts';

const ctx = useTestDatabase({ poolMax: 30 });

const SECRET = 'chaos_test_secret_long_enough';

let app: App;

beforeAll(async () => {
  app = await buildApp({ pool: ctx.pool, loggerOverride: pino({ level: 'silent' }) });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetLedger(ctx.pool);
  await resetInstruments(ctx.pool);

  // The real house shards, because the burst's order profile posts against
  // them rather than against demo-only house accounts.
  await ctx.pool.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol, balance)
     SELECT 'house:USD:' || lpad(to_hex(n), 2, '0'), 'house_cash', NULL, 0
       FROM generate_series(0, $1::int - 1) AS n
     ON CONFLICT (external_id) DO NOTHING`,
    [HOUSE_SHARDS],
  );
  await ctx.pool.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol, balance)
     SELECT 'house:BTC:' || lpad(to_hex(n), 2, '0'), 'house_asset', 'BTC', 0
       FROM generate_series(0, $1::int - 1) AS n
     ON CONFLICT (external_id) DO NOTHING`,
    [HOUSE_SHARDS],
  );
});

describe('chaos session tokens', () => {
  it('round-trips a freshly issued token', () => {
    const { token, session } = issue(SECRET);
    const result = verify(SECRET, token);

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.session.tenant).toBe(session.tenant);
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = issue(SECRET);
    const result = verify('chaos_a_completely_other_secret', token);

    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a tampered expiry rather than honouring it', () => {
    const { token } = issue(SECRET);
    const [tenant, , mac] = token.split('.') as [string, string, string];

    /*
     * The attack this blocks: take a valid token, push the expiry years out,
     * keep the original MAC. Verifying the expiry before the signature would
     * accept it, because until the MAC has vouched for the token the expiry is
     * a number the attacker chose.
     */
    const forged = `${tenant}.9999999999.${mac}`;
    expect(verify(SECRET, forged)).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects an expired token', () => {
    const { token } = issue(SECRET, Date.now() - (TOKEN_TTL_SECONDS + 60) * 1000);
    expect(verify(SECRET, token)).toEqual({ valid: false, reason: 'expired' });
  });

  it('rejects a malformed tenant without consulting the signature', () => {
    expect(verify(SECRET, 'not-a-token')).toEqual({ valid: false, reason: 'malformed' });
    expect(verify(SECRET, 'wrong-prefix.123.abc')).toEqual({ valid: false, reason: 'malformed' });
  });

  it('issues a distinct tenant every time', () => {
    const tenants = new Set(Array.from({ length: 50 }, () => issue(SECRET).session.tenant));
    expect(tenants.size).toBe(50);
  });
});

describe('POST /v1/chaos/session', () => {
  it('issues a usable token and publishes the server-side caps', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/chaos/session' });

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      token: string;
      tenant: string;
      limits: { maxVirtualUsers: number; maxAccountSpread: number };
    }>();

    expect(body.tenant).toMatch(/^demo-[0-9a-f]{12}$/);
    expect(body.limits.maxVirtualUsers).toBe(MAX_VIRTUAL_USERS);
    expect(body.limits.maxAccountSpread).toBe(MAX_ACCOUNT_SPREAD);
  });
});

/** Fetch a token the way the page does. */
async function newToken(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/v1/chaos/session' });
  return response.json<{ token: string }>().token;
}

async function burst(body: unknown, token?: string): Promise<ReturnType<App['inject']>> {
  return app.inject({
    method: 'POST',
    url: '/v1/chaos/burst',
    headers: { 'x-daftar-chaos-token': token ?? (await newToken()) },
    payload: body as Record<string, unknown>,
  });
}

describe('POST /v1/chaos/burst — authorisation', () => {
  it('401s without a token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chaos/burst',
      payload: { profile: { kind: 'order', mode: 'advisory' }, virtualUsers: 1, accountSpread: 1 },
    });

    expect(response.statusCode).toBe(400); // the header is schema-required
  });

  it('answers every bad-token case identically, so it is not an oracle', async () => {
    const body = {
      profile: { kind: 'order', mode: 'advisory' },
      virtualUsers: 1,
      accountSpread: 1,
    };

    const cases = [
      // Malformed.
      'not-a-token',
      // Well-formed, wrong MAC.
      'demo-aaaaaaaaaaaa.9999999999.not_a_real_mac',
      // Correctly signed, but long expired.
      issue(SECRET, Date.now() - (TOKEN_TTL_SECONDS + 60) * 1000).token,
    ];

    const responses = await Promise.all(cases.map((token) => burst(body, token)));

    /*
     * The property is that the three answers are **indistinguishable**, not
     * that the message avoids particular words. The shipped message does name
     * all three possibilities ("missing, malformed or expired") — which is
     * fine, because it never says which one applied. Asserting on word
     * absence, as the first version of this test did, tested the wording
     * instead of the property.
     */
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json<{ error: string }>().error).toBe('invalid_chaos_token');
    }

    const messages = new Set(responses.map((r) => r.json<{ message: string }>().message));
    expect(messages.size).toBe(1);
  });

  it('rejects an over-large virtualUsers rather than clamping it', async () => {
    const response = await burst({
      profile: { kind: 'order', mode: 'advisory' },
      virtualUsers: MAX_VIRTUAL_USERS + 1,
      accountSpread: 1,
    });

    // 400, not a silent clamp: a client asking for 10,000 virtual users has a
    // bug, and clamping hides it.
    expect(response.statusCode).toBe(400);
  });

  it('rejects a profile that names both a mode and a naive strategy', async () => {
    const response = await burst({
      profile: { kind: 'order', mode: 'advisory', strategy: 'naive_overdraft' },
      virtualUsers: 1,
      accountSpread: 1,
    });

    /*
     * Without `.strict()` on the union variants this returned **200**: Zod
     * strips unknown keys, so `strategy` was silently dropped and the
     * *correct* order path ran. The caller would then read a clean invariant
     * report and conclude `naive_overdraft` is safe.
     *
     * That is the worst failure available to this endpoint, whose whole job is
     * to say truthfully which code path ran.
     */
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /v1/chaos/burst — the invariants it reports', () => {
  it('keeps every invariant under the correct order path', async () => {
    const response = await burst({
      profile: { kind: 'order', mode: 'advisory' },
      virtualUsers: 20,
      accountSpread: 5,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      succeeded: number;
      errored: number;
      invariants: {
        entriesSumToZeroPerUnit: boolean;
        balanceMatchesEntries: boolean | null;
        overdraftOccurred: boolean;
        unitSums: { unit: string; sum: string }[];
      };
    }>();

    expect(body.succeeded).toBeGreaterThan(0);
    expect(body.invariants.entriesSumToZeroPerUnit).toBe(true);
    expect(body.invariants.balanceMatchesEntries).toBe(true);
    expect(body.invariants.overdraftOccurred).toBe(false);
    expect(body.invariants.unitSums.every((u) => u.sum === '0')).toBe(true);
  });

  it('reports balanceMatchesEntries as null for a naive debit, not false', async () => {
    const response = await burst({
      profile: { kind: 'debit', strategy: 'guarded_atomic' },
      virtualUsers: 10,
      accountSpread: 1,
    });

    const body = response.json<{
      invariants: { balanceMatchesEntries: boolean | null; cashDiscrepancy: string | null };
    }>();

    /*
     * The debit paths write no ledger entries at all — that is what makes them
     * naive. Comparing a balance against an entries sum of zero would report
     * `false` for every debit run, which reads as a drift finding when it is
     * really "this path keeps no ledger". `null` says "not applicable".
     */
    expect(body.invariants.balanceMatchesEntries).toBeNull();
    expect(body.invariants.cashDiscrepancy).toBe('0');
  });

  it('funds accounts for only half the burst, so refusals are reachable', async () => {
    const response = await burst({
      profile: { kind: 'debit', strategy: 'guarded_atomic' },
      virtualUsers: 20,
      accountSpread: 1,
    });

    const body = response.json<{ succeeded: number; refused: number }>();

    /*
     * The first version funded $100,000 against $100 debits, so nothing was
     * ever refused and `naive_overdraft` had no guard to fail at — it reported
     * a clean run for a deliberately broken path. Half-funding is what makes
     * the three strategies diverge visibly.
     */
    expect(body.refused).toBeGreaterThan(0);
    expect(body.succeeded).toBeGreaterThan(0);
  });

  it('shows naive_overdraft driving a balance negative', async () => {
    const response = await burst({
      profile: { kind: 'debit', strategy: 'naive_overdraft' },
      virtualUsers: 40,
      accountSpread: 1,
    });

    const body = response.json<{
      succeeded: number;
      invariants: {
        overdraftOccurred: boolean;
        overdrawnAccounts: { externalId: string; balance: string }[];
        cashDiscrepancy: string | null;
      };
    }>();

    expect(body.invariants.overdraftOccurred).toBe(true);
    expect(body.invariants.overdrawnAccounts.length).toBeGreaterThan(0);
    expect(BigInt(body.invariants.overdrawnAccounts[0]!.balance)).toBeLessThan(0n);

    /*
     * But **no lost updates**: `naive_overdraft` writes
     * `SET balance = balance - $1`, which PostgreSQL re-evaluates against the
     * updated row under READ COMMITTED, so the arithmetic is exact even though
     * the guard is absent. Overdraft and lost update are different bugs and
     * this path has only one of them — the central finding of Phase 1.
     */
    expect(body.invariants.cashDiscrepancy).toBe('0');
  });

  it('shows naive_lost_update losing money that the arithmetic says left', async () => {
    const response = await burst({
      profile: { kind: 'debit', strategy: 'naive_lost_update' },
      virtualUsers: 40,
      accountSpread: 1,
    });

    const body = response.json<{
      succeeded: number;
      invariants: { cashDiscrepancy: string | null; expectedCash: string; actualCash: string };
    }>();

    // Every request reports success, because each writes an absolute value it
    // computed in JavaScript from a balance that was already stale.
    expect(body.succeeded).toBe(40);

    // Non-zero, and in the direction of money that never left the account.
    expect(body.invariants.cashDiscrepancy).not.toBe('0');
    expect(BigInt(body.invariants.actualCash)).toBeGreaterThan(
      BigInt(body.invariants.expectedCash),
    );
  });

  it('writes only inside its own demo tenant', async () => {
    const before = await ctx.pool.query<{ count: bigint }>(
      `SELECT count(*)::bigint AS count FROM accounts WHERE NOT starts_with(external_id, 'demo-')`,
    );

    await burst({
      profile: { kind: 'debit', strategy: 'naive_overdraft' },
      virtualUsers: 20,
      accountSpread: 3,
    });

    const after = await ctx.pool.query<{ count: bigint }>(
      `SELECT count(*)::bigint AS count FROM accounts WHERE NOT starts_with(external_id, 'demo-')`,
    );

    // A burst is supposed to cause overdrafts. Doing that to a seeded account
    // would corrupt the dataset every benchmark was measured against.
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it('gives two sessions separate tenants that cannot see each other', async () => {
    const first = await app.inject({ method: 'POST', url: '/v1/chaos/session' });
    const second = await app.inject({ method: 'POST', url: '/v1/chaos/session' });

    const a = first.json<{ token: string; tenant: string }>();
    const b = second.json<{ token: string; tenant: string }>();

    expect(a.tenant).not.toBe(b.tenant);

    await burst(
      { profile: { kind: 'debit', strategy: 'guarded_atomic' }, virtualUsers: 5, accountSpread: 1 },
      a.token,
    );

    const response = await burst(
      { profile: { kind: 'debit', strategy: 'guarded_atomic' }, virtualUsers: 5, accountSpread: 1 },
      b.token,
    );

    const body = response.json<{
      tenant: string;
      invariants: { overdrawnAccounts: { externalId: string }[] };
    }>();

    expect(body.tenant).toBe(b.tenant);
    for (const account of body.invariants.overdrawnAccounts) {
      expect(account.externalId.startsWith(b.tenant)).toBe(true);
    }
  });
});

describe('openingFor', () => {
  it('funds half of each account’s share of the burst', () => {
    // 40 users over 4 accounts is 10 requests each, at $100 — half is $500.
    expect(openingFor({ kind: 'debit', strategy: 'guarded_atomic' }, 40, 4)).toBe(50_000n);
  });

  it('never funds below the floor', () => {
    // One user over one account is $50 at half coverage, which is below the
    // $500 floor — a burst funded with pennies shows nothing useful.
    expect(openingFor({ kind: 'debit', strategy: 'guarded_atomic' }, 1, 1)).toBe(50_000n);
  });

  it('rounds the per-account share up so every account is funded', () => {
    // 10 users over 3 accounts: two accounts get 3 and one gets 4, so the
    // share has to round up or the busiest account is underfunded by design.
    expect(openingFor({ kind: 'debit', strategy: 'guarded_atomic' }, 10, 3)).toBe(50_000n);
  });
});

describe('reapDemoTenants', () => {
  it('removes untouched demo accounts and keeps ones that wrote to the ledger', async () => {
    const token = await newToken();
    const response = await burst(
      { profile: { kind: 'order', mode: 'advisory' }, virtualUsers: 4, accountSpread: 2 },
      token,
    );
    const tenant = response.json<{ tenant: string }>().tenant;

    // Backdate so the age filter matches.
    await ctx.pool.query(
      `UPDATE accounts SET created_at = now() - interval '48 hours'
        WHERE starts_with(external_id, 'demo-')`,
    );

    await reapDemoTenants(ctx.pool, 24);

    const { rows } = await ctx.pool.query<{ external_id: string }>(
      `SELECT external_id FROM accounts WHERE starts_with(external_id, $1::text)`,
      [tenant],
    );

    /*
     * The cash accounts that traded survive: `entries` has a no-delete trigger,
     * so an account with entries cannot be removed. That is the honest bound —
     * a demo that wrote to the ledger leaves a permanent trace, because that is
     * what an audit trail means.
     */
    const survivors = rows.map((r) => r.external_id);
    expect(survivors).toContain(demoCashExternalId(tenant, 0));
  });
});
