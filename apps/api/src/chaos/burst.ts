import type pg from 'pg';
import { parseCash, parseQuantity } from '@daftar/money';
import type { LedgerConcurrencyMode } from '../env.ts';
import { placeOrder } from '../orders/place.ts';
import { HOUSE_SHARDS } from '../orders/place.ts';
import { debit, type DebitStrategy } from '../ledger/naive.ts';
import { demoCashExternalId, demoPositionExternalId } from './session.ts';

/**
 * # The server-side burst
 *
 * ## Why this is not a browser loop
 *
 * A browser allows 6 concurrent connections per origin on HTTP/1.1 and runs one
 * JavaScript thread. A `Promise.all` of 200 `fetch` calls from a page is
 * therefore a queue of 6, not a storm of 200 — the database would see at most
 * six overlapping transactions and every invariant would hold comfortably.
 *
 * That failure mode is worse than having no chaos panel: it would show the
 * ledger surviving load that never happened, and in doing so quietly discredit
 * every measured number in `docs/evidence/`. The concurrency has to be real, so
 * it is created where real concurrency is possible — in the server, against the
 * pool, with the same code path a production order takes.
 *
 * ## Every write lands in a per-session demo tenant
 *
 * A burst is *supposed* to cause overdrafts when a naive flag is set. Pointing
 * that at a seeded account would corrupt the dataset that Phase 3 and Phase 6
 * measured against, and the corruption would be invisible until a later
 * benchmark produced a number nobody could explain. Tenants are created on
 * demand, used once, and reaped.
 */

/**
 * The per-request debit, and the funding rule that makes the panel informative.
 *
 * ## Why accounts are deliberately underfunded
 *
 * The first version funded every demo account with $100,000 against $100
 * debits, so a 60-user burst spent 6% of the balance. Under that profile
 * `naive_overdraft` demonstrated **nothing**: no request was ever refused, so
 * the missing guard had nothing to fail at, and the panel reported a clean run
 * for a path that is deliberately broken.
 *
 * The interesting region is where the account cannot cover the whole burst.
 * Each account is funded for **half** of its share of the requests, so
 * approximately half should be refused — and the three paths then diverge
 * visibly:
 *
 *   - `guarded_atomic`  → about half refused, balance never negative
 *   - `naive_overdraft` → nothing refused, balance goes **negative**
 *   - `naive_lost_update` → nothing refused, and the balance is *higher* than
 *     the arithmetic allows, because concurrent writers overwrote each other
 *
 * Funding is topped up at the start of every burst rather than only at account
 * creation, so a second burst with different parameters starts from the same
 * well-defined state instead of inheriting the first one's leftovers.
 */
const DEMO_FUNDING_COVERAGE = 2n;

/** A floor, so a 1-user burst still has a sensible balance to look at. */
const DEMO_MIN_OPENING = parseCash('500.00');

/** The per-order quantity. Small, fixed, and the same for every virtual user. */
const DEMO_QUANTITY = parseQuantity('0.00100000');

/** The per-request debit for the naive-flag profiles, in cash minor units. */
const DEMO_DEBIT = parseCash('100.00');

export type BurstProfile =
  /** The real double-entry order path, under one of the three strategies. */
  | { kind: 'order'; mode: LedgerConcurrencyMode }
  /** A Phase 1 naive debit path, kept runnable on purpose. */
  | { kind: 'debit'; strategy: DebitStrategy };

export interface BurstRequest {
  tenant: string;
  profile: BurstProfile;
  /** Concurrent virtual users. Capped by the route before it gets here. */
  virtualUsers: number;
  /** How many distinct accounts the load is spread over. */
  accountSpread: number;
}

export interface BurstResult {
  profile: BurstProfile;
  virtualUsers: number;
  accountSpread: number;
  /** Requests issued. Equals `virtualUsers`; stated so the ratios have a base. */
  attempted: number;
  succeeded: number;
  /** Refused for insufficient funds — the *correct* outcome, not a failure. */
  refused: number;
  /** Threw. A 5xx a real customer would have seen. */
  errored: number;
  /** Total ledger attempts across all requests; > attempted means retries. */
  totalAttempts: number;
  serializationFailures: number;
  deadlocks: number;
  durationMs: number;
  /** Requests per second, computed from placed-only. See the note below. */
  throughput: number;
  /** What each account was funded with for this run, so refusals are explicable. */
  openingPerAccount: string;
  invariants: BurstInvariants;
}

export interface BurstInvariants {
  /**
   * `SUM(entries.amount) = 0` across the whole ledger, per unit.
   *
   * The headline invariant. Checked globally rather than for this tenant, since
   * a bug that unbalanced the ledger would not politely confine itself.
   */
  entriesSumToZeroPerUnit: boolean;
  /** Per-unit sums, so a failure says which unit and by how much. */
  unitSums: { unit: string; sum: string }[];
  /** Any demo cash account that went below zero. */
  overdrawnAccounts: { externalId: string; balance: string }[];
  /** True when at least one account went negative. */
  overdraftOccurred: boolean;
  /**
   * `accounts.balance` versus the sum of that account's entries.
   *
   * **`null` for the `debit` profiles, and that is not a gap — it is the
   * point.** The Phase 1 naive paths update `accounts.balance` and write *no
   * ledger entries at all*; that is what makes them naive. Comparing a balance
   * against an entries sum of zero would report `false` for every debit run,
   * which looks like a drift finding and is really just "this path does not
   * keep a ledger".
   *
   * For the order profile it is the real check: the balance column and the
   * entries are maintained by the same transaction but are separate facts, so a
   * disagreement is a genuine lost update.
   */
  balanceMatchesEntries: boolean | null;
  drift: { externalId: string; balance: string; entriesSum: string }[];
  /**
   * What the tenant's total cash *should* be if every success was recorded
   * exactly once, versus what it is.
   *
   * This is the check that carries the weight for the `debit` profiles, where
   * the amount per request is a constant and the arithmetic is therefore
   * closed. A gap is a lost update, stated in money.
   */
  expectedCash: string | null;
  actualCash: string | null;
  /** `expectedCash - actualCash`, when both are known. Money that vanished. */
  cashDiscrepancy: string | null;
}

/**
 * Create the demo tenant's accounts, idempotently.
 *
 * `ON CONFLICT` so a second burst in the same session reuses the accounts
 * rather than failing — and so two bursts fired concurrently from two tabs do
 * not race each other into a unique violation.
 *
 * House shards are **not** created here. The demo orders post against the real
 * house accounts, because that is the real write path and the contention on the
 * house row is the most interesting thing a burst can demonstrate. The house
 * accounts net to zero over a buy and its mirror leg, so a demo cannot leave
 * them in a state that means anything.
 */
export async function ensureTenant(
  pool: pg.Pool,
  tenant: string,
  accountSpread: number,
  opening: bigint,
  symbol = 'BTC',
): Promise<string[]> {
  const cashIds = Array.from({ length: accountSpread }, (_, i) => demoCashExternalId(tenant, i));

  /*
   * `DO UPDATE SET balance` rather than `DO NOTHING`, so the funding is reset
   * every burst. A second burst with different parameters would otherwise
   * inherit whatever the first one left behind, and its refusal count would
   * depend on history rather than on the settings the user chose.
   *
   * Writing `balance` directly is only acceptable because these accounts exist
   * outside the ledger's audit story — they are demo scaffolding, reaped later.
   * Nothing else in this repo sets a balance without a matching entry.
   */
  await pool.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol, balance)
     SELECT unnest($1::text[]), 'customer_cash', NULL, $2::bigint
     ON CONFLICT (external_id) DO UPDATE SET balance = $2::bigint`,
    [cashIds, opening.toString()],
  );

  await pool.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol, balance)
     SELECT unnest($1::text[]), 'customer_asset', $2, 0
     ON CONFLICT (external_id) DO NOTHING`,
    [cashIds.map((id) => demoPositionExternalId(id, symbol)), symbol],
  );

  return cashIds;
}

/**
 * Funding per account: half of what its share of the burst will try to spend.
 *
 * Rounded up so a burst that spreads unevenly still funds every account, and
 * floored at `DEMO_MIN_OPENING` so a tiny burst is not funded with pennies.
 */
export function openingFor(
  profile: BurstProfile,
  virtualUsers: number,
  accountSpread: number,
): bigint {
  const perAccount = BigInt(Math.ceil(virtualUsers / accountSpread));

  // An order's cost is quantity x frozen price, which this function does not
  // know. Funded generously instead: the order path is the *correct* one, so
  // the interesting thing there is contention and retries, not refusals.
  const costPerRequest = profile.kind === 'debit' ? DEMO_DEBIT : parseCash('500.00');

  const target = (perAccount * costPerRequest) / DEMO_FUNDING_COVERAGE;
  return target < DEMO_MIN_OPENING ? DEMO_MIN_OPENING : target;
}

/**
 * Run the burst.
 *
 * All virtual users start together via `Promise.all` on already-created
 * promises. Starting them inside a loop with an `await` would serialise them
 * and measure latency rather than contention.
 */
export async function runBurst(pool: pg.Pool, request: BurstRequest): Promise<BurstResult> {
  const { tenant, profile, virtualUsers, accountSpread } = request;

  const opening = openingFor(profile, virtualUsers, accountSpread);
  const cashIds = await ensureTenant(pool, tenant, accountSpread, opening);

  /**
   * A nonce per run, mixed into every order's external id.
   *
   * Without it, a second burst in the same session reuses ids from the first
   * and every request comes back `duplicate_external_id` — which shows up as a
   * 100% failure rate that has nothing to do with concurrency. That exact
   * mistake produced a fake 2–3% failure rate in the Phase 3 harness.
   */
  const nonce = Date.now().toString(36);

  const started = performance.now();

  const outcomes = await Promise.all(
    Array.from({ length: virtualUsers }, (_, vu) => {
      // Round-robin, so the spread is even rather than random. A random
      // assignment at low virtual-user counts leaves some accounts untouched
      // and makes two runs with the same settings incomparable.
      const cashExternalId = cashIds[vu % cashIds.length]!;
      return runOne(pool, profile, cashExternalId, `${tenant}-${nonce}-${String(vu)}`);
    }),
  );

  const durationMs = performance.now() - started;

  const succeeded = outcomes.filter((o) => o.outcome === 'succeeded').length;
  const refused = outcomes.filter((o) => o.outcome === 'refused').length;
  const errored = outcomes.filter((o) => o.outcome === 'errored').length;

  return {
    profile,
    virtualUsers,
    accountSpread,
    attempted: virtualUsers,
    succeeded,
    refused,
    errored,
    totalAttempts: outcomes.reduce((total, o) => total + o.attempts, 0),
    serializationFailures: outcomes.reduce((total, o) => total + o.serializationFailures, 0),
    deadlocks: outcomes.reduce((total, o) => total + o.deadlocks, 0),
    durationMs: Math.round(durationMs * 1000) / 1000,

    /**
     * **Successes only**, not attempts.
     *
     * Counting failures as throughput is how a strategy that sheds 88% of its
     * load reports the highest number in the table — which it did, once, in an
     * early Phase 3 run that claimed 801 orders/s while failing most of them.
     */
    throughput: durationMs === 0 ? 0 : Math.round((succeeded / durationMs) * 1000 * 100) / 100,

    openingPerAccount: opening.toString(),
    invariants: await checkInvariants(pool, tenant, profile, succeeded, opening),
  };
}

interface OneOutcome {
  outcome: 'succeeded' | 'refused' | 'errored';
  attempts: number;
  serializationFailures: number;
  deadlocks: number;
}

async function runOne(
  pool: pg.Pool,
  profile: BurstProfile,
  cashExternalId: string,
  externalId: string,
): Promise<OneOutcome> {
  try {
    if (profile.kind === 'order') {
      const result = await placeOrder(pool, {
        externalId,
        cashAccountExternalId: cashExternalId,
        symbol: 'BTC',
        side: 'buy',
        quantity: DEMO_QUANTITY,
        mode: profile.mode,
      });

      return {
        outcome:
          result.status === 'placed'
            ? 'succeeded'
            : result.status === 'insufficient_funds'
              ? 'refused'
              : 'errored',
        attempts: result.attempts,
        serializationFailures: result.serializationFailures,
        deadlocks: result.deadlocks,
      };
    }

    /*
     * The naive debit path takes a PoolClient, not the pool — the read and the
     * write have to be in the same transaction for the race to be the one
     * being demonstrated. Released in `finally` so a burst cannot leak the pool
     * dry when something throws mid-transaction.
     */
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ id: bigint }>(
        'SELECT id FROM accounts WHERE external_id = $1',
        [cashExternalId],
      );
      const accountId = rows[0]?.id;
      if (accountId === undefined) {
        return { outcome: 'errored', attempts: 1, serializationFailures: 0, deadlocks: 0 };
      }

      const result = await debit(client, {
        accountId,
        amount: DEMO_DEBIT,
        strategy: profile.strategy,
      });

      return {
        outcome:
          result.status === 'applied'
            ? 'succeeded'
            : result.status === 'insufficient_funds'
              ? 'refused'
              : 'errored',
        attempts: 1,
        serializationFailures: 0,
        deadlocks: 0,
      };
    } finally {
      client.release();
    }
  } catch {
    // Swallowed deliberately and counted. A burst exists to produce failures;
    // one rejected promise must not abort the other 199 and lose their results.
    return { outcome: 'errored', attempts: 1, serializationFailures: 0, deadlocks: 0 };
  }
}

/**
 * Check the invariants after the burst.
 *
 * Read in one round trip each, after all writes have committed. Checking
 * mid-burst would read a partially-applied state and report a violation that is
 * just an in-flight transaction.
 */
async function checkInvariants(
  pool: pg.Pool,
  tenant: string,
  profile: BurstProfile,
  succeeded: number,
  opening: bigint,
): Promise<BurstInvariants> {
  const { rows: unitSums } = await pool.query<{ unit: string; sum: bigint }>(
    `SELECT unit, sum(amount)::bigint AS sum FROM entries GROUP BY unit ORDER BY unit`,
  );

  /**
   * Demo accounts only, found by prefix.
   *
   * `starts_with`, not `LIKE` — the tenant is server-generated so it contains
   * no wildcards today, but `LIKE` would make that a property of the generator
   * rather than of the query, and the same mistake already shipped once in the
   * positions endpoint.
   */
  const { rows: accounts } = await pool.query<{
    external_id: string;
    balance: bigint;
    entries_sum: bigint;
  }>(
    `SELECT a.external_id,
            a.balance,
            coalesce(sum(e.amount), 0)::bigint AS entries_sum
       FROM accounts a
       LEFT JOIN entries e ON e.account_id = a.id
      WHERE starts_with(a.external_id, $1::text || ':')
        AND a.kind = 'customer_cash'
      GROUP BY a.external_id, a.balance
      ORDER BY a.external_id`,
    [tenant],
  );

  const overdrawn = accounts.filter((a) => a.balance < 0n);
  const drift = accounts.filter((a) => a.balance !== opening + a.entries_sum);

  /**
   * Expected cash across the tenant, if every success was recorded exactly once.
   *
   * Only computable for the `debit` profiles, where the amount per request is a
   * constant. An order's notional depends on the frozen price, and quoting an
   * "expected" figure that assumed a price would be a guess dressed as a check
   * — so it is `null` there, and `balanceMatchesEntries` carries the load
   * instead.
   */
  const openingTotal = opening * BigInt(accounts.length);
  const expected = profile.kind === 'debit' ? openingTotal - DEMO_DEBIT * BigInt(succeeded) : null;
  const actual = accounts.reduce((total, a) => total + a.balance, 0n);

  // Only meaningful for the order profile — see the note on the field.
  const isOrderProfile = profile.kind === 'order';

  return {
    entriesSumToZeroPerUnit: unitSums.every((r) => r.sum === 0n),
    unitSums: unitSums.map((r) => ({ unit: r.unit, sum: r.sum.toString() })),
    overdrawnAccounts: overdrawn.map((a) => ({
      externalId: a.external_id,
      balance: a.balance.toString(),
    })),
    overdraftOccurred: overdrawn.length > 0,
    balanceMatchesEntries: isOrderProfile ? drift.length === 0 : null,
    drift: isOrderProfile
      ? drift.map((a) => ({
          externalId: a.external_id,
          balance: a.balance.toString(),
          entriesSum: a.entries_sum.toString(),
        }))
      : [],
    expectedCash: expected === null ? null : expected.toString(),
    actualCash: actual.toString(),
    cashDiscrepancy: expected === null ? null : (expected - actual).toString(),
  };
}

/**
 * Delete demo tenants older than `olderThanHours`.
 *
 * Demo accounts accumulate — every session creates up to 50 of them plus their
 * position accounts — and `entries` has a no-delete trigger, so a tenant that
 * ever traded cannot be removed. Only untouched accounts are reaped, which is
 * the honest bound: a demo that wrote to the ledger leaves a permanent trace,
 * because that is what an audit trail means.
 */
export async function reapDemoTenants(pool: pg.Pool, olderThanHours = 24): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM accounts a
      WHERE starts_with(a.external_id, 'demo-')
        AND a.created_at < now() - make_interval(hours => $1::int)
        AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.account_id = a.id)`,
    [olderThanHours],
  );
  return rowCount ?? 0;
}

export { DEMO_DEBIT, DEMO_QUANTITY, DEMO_MIN_OPENING, HOUSE_SHARDS };
