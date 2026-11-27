/**
 * Phase 1 load harness — make the naive ledger paths break under real
 * concurrency, and record by how much.
 *
 * Usage:
 *
 *   ./.tools/bin/k6 run load/naive-break.js                      # correct path
 *   DAFTAR_MODE=naive_overdraft   ./.tools/bin/k6 run load/naive-break.js
 *   DAFTAR_MODE=naive_lost_update ./.tools/bin/k6 run load/naive-break.js
 *
 * Environment:
 *   BASE_URL     default http://127.0.0.1:3000
 *   DAFTAR_MODE  guarded_atomic (default) | naive_overdraft | naive_lost_update
 *   VUS          default 500
 *   OPENING      opening balance, decimal string, default "100.00"
 *   DEBIT        per-VU debit amount, decimal string, default "1.00"
 *   WARMUP_MS    barrier lead time, default 3000
 *
 * ## Three things about the executor choice that matter
 *
 * **1. `per-vu-iterations`, not `ramping-vus`.** All VUs are initialised before
 * the test starts and each runs the body exactly once. `ramping-vus` exists to
 * model a realistic arrival ramp, which is the opposite of what race testing
 * needs: a ramp spreads arrivals out, so the window where two transactions
 * overlap gets narrower the better the ramp works.
 *
 * **2. An explicit wall-clock barrier.** Even pre-initialised VUs do not start
 * their iteration at the same instant — k6 staggers them, and the first request
 * on a connection pays DNS and TCP setup. So `setup()` publishes a release
 * timestamp, every VU warms its connection and then sleeps until that instant.
 * Without this, the earliest VUs have committed before the last ones have read,
 * and the naive paths look far better than they are.
 *
 * **3. `maxVUs` is not the knob here, but it is worth naming.** For the
 * *arrival-rate* executors (`constant-arrival-rate`, `ramping-arrival-rate`),
 * `maxVUs` defaults to `preAllocatedVUs`, so a scenario targeting high
 * throughput with a small `preAllocatedVUs` silently caps there and reports a
 * lower rate with no error. `per-vu-iterations` takes `vus` directly and has no
 * such trap — but Phase 3 and Phase 10 use arrival-rate executors, where it
 * applies.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const MODE = __ENV.DAFTAR_MODE || 'guarded_atomic';
const VUS = Number(__ENV.VUS || 500);
const OPENING = __ENV.OPENING || '100.00';
const DEBIT = __ENV.DEBIT || '1.00';
const WARMUP_MS = Number(__ENV.WARMUP_MS || 3000);

const MODE_HEADERS = {
  guarded_atomic: {},
  naive_overdraft: { 'x-daftar-naive-overdraft': 'true' },
  naive_lost_update: { 'x-daftar-naive-lost-update': 'true' },
};

if (!(MODE in MODE_HEADERS)) {
  throw new Error(`unknown DAFTAR_MODE "${MODE}" — expected one of ${Object.keys(MODE_HEADERS)}`);
}

const applied = new Counter('debits_applied');
const refused = new Counter('debits_refused');
const failed = new Counter('debits_failed');
const barrierSkew = new Trend('barrier_skew_ms', true);

export const options = {
  scenarios: {
    stampede: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      // Generous: the barrier itself consumes WARMUP_MS, and under
      // naive_overdraft every transaction queues behind the row lock.
      maxDuration: '120s',
      gracefulStop: '30s',
    },
  },
  // Deliberately NOT thresholds that abort the run. The point of this script is
  // to record what happens, including a flood of 5xx if that is what happens.
  // An aborting threshold would discard the measurement it was meant to protect.
  thresholds: {},
  // One decimal of precision is plenty and keeps the summary readable.
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max'],
  // No connection reuse limits: a fresh connection per iteration would mean
  // measuring TCP setup rather than lock contention.
  noConnectionReuse: false,
  discardResponseBodies: false,
};

/** Minor-unit arithmetic in the harness too — no floats on amounts. */
function toMinor(decimal) {
  const [whole, frac = ''] = decimal.split('.');
  return BigInt(whole + frac.padEnd(2, '0').slice(0, 2));
}

function fromMinor(minor) {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(3, '0');
  const cut = digits.length - 2;
  return `${negative ? '-' : ''}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

export function setup() {
  // A unique account per run. No destructive reset endpoint exists, and none
  // should: a load script that can wipe a database is one typo away from wiping
  // the wrong one.
  const externalId = `load-${MODE}-${Date.now()}`;

  const created = http.post(
    `${BASE_URL}/v1/accounts`,
    JSON.stringify({ externalId, kind: 'customer_cash', openingBalance: OPENING }),
    { headers: { 'Content-Type': 'application/json' }, tags: { phase: 'setup' } },
  );

  if (created.status !== 201) {
    throw new Error(`setup failed to create account: ${created.status} ${created.body}`);
  }

  // Published to every VU. `Date.now()` in setup and in the VU context are the
  // same wall clock because k6 runs them in one process on one machine; this
  // would need rethinking for a distributed run.
  const releaseAt = Date.now() + WARMUP_MS;

  console.log(
    `[setup] account=${externalId} opening=${OPENING} debit=${DEBIT} vus=${VUS} mode=${MODE}`,
  );

  return { externalId, releaseAt };
}

export default function (data) {
  const { externalId, releaseAt } = data;

  /**
   * Pre-warm. The first request from a VU pays connection setup, which on a
   * loopback connection is small but not zero and — more importantly — is
   * *variable*. Spending it before the barrier means every VU arrives at the
   * debit with an established connection.
   */
  http.get(`${BASE_URL}/health/live`, { tags: { phase: 'warmup' } });

  // Busy-ish wait on the shared timestamp. `sleep()` takes seconds and is
  // coarse, so the remaining time is slept in one go and the final few
  // milliseconds are spun out — the skew that matters is sub-10ms.
  const remaining = releaseAt - Date.now();
  if (remaining > 20) {
    // k6's sleep takes seconds. Leave 10ms on the clock for the spin below:
    // sleep's resolution is not fine enough to land on the instant, and the
    // skew that matters here is sub-10ms.
    sleep((remaining - 10) / 1000);
  }
  while (Date.now() < releaseAt) {
    // spin
  }

  // How far past the release instant this VU actually started. Published as a
  // metric because it is the honest measure of how concurrent the "concurrent"
  // run was — a p99 skew of 200ms would mean the barrier did not work and the
  // result should not be trusted.
  barrierSkew.add(Date.now() - releaseAt);

  const res = http.post(
    `${BASE_URL}/v1/accounts/${externalId}/debits`,
    JSON.stringify({ amount: DEBIT }),
    {
      headers: { 'Content-Type': 'application/json', ...MODE_HEADERS[MODE] },
      tags: { phase: 'debit', mode: MODE },
    },
  );

  if (res.status === 200) {
    applied.add(1);
  } else if (res.status === 422) {
    refused.add(1);
  } else {
    failed.add(1);
    console.error(`[vu ${exec.vu.idInTest}] unexpected ${res.status}: ${res.body}`);
  }

  check(res, {
    'no server error': (r) => r.status < 500,
    'strategy is the one requested': (r) => {
      if (r.status !== 200 && r.status !== 422) return true;
      try {
        return JSON.parse(r.body).strategy === MODE;
      } catch {
        return false;
      }
    },
  });
}

export function teardown(data) {
  const { externalId } = data;

  const res = http.get(`${BASE_URL}/v1/accounts/${externalId}`, { tags: { phase: 'teardown' } });
  if (res.status !== 200) {
    throw new Error(`teardown failed to read account: ${res.status} ${res.body}`);
  }

  const finalBalance = toMinor(JSON.parse(res.body).balance);
  const opening = toMinor(OPENING);
  const debit = toMinor(DEBIT);

  console.log('');
  console.log(`=== ${MODE} ===`);
  console.log(`account            ${externalId}`);
  console.log(`opening balance    ${fromMinor(opening)}`);
  console.log(`debit per VU       ${fromMinor(debit)}`);
  console.log(`VUs                ${VUS}`);
  console.log(`final balance      ${fromMinor(finalBalance)}`);
  console.log(`overdrawn          ${finalBalance < 0n ? 'YES' : 'no'}`);
  console.log('');
  console.log('Counts come from the k6 summary below (debits_applied /');
  console.log('debits_refused / debits_failed). The lost-update count is');
  console.log('computed against them by hand, because teardown cannot read');
  console.log("this run's counters.");
}

/**
 * Emit machine-readable output alongside the human summary, so the evidence
 * file is transcribed from a file rather than from a screenshot of a terminal.
 */
export function handleSummary(summary) {
  const out = `load/out/naive-break-${MODE}.json`;
  return {
    stdout: textSummary(summary),
    [out]: JSON.stringify(summary, null, 2),
  };
}

/**
 * Minimal text summary. k6's own `textSummary` lives in a jslib module fetched
 * over the network at run time; depending on a remote import inside a
 * measurement harness means a run can fail, or silently change, because of
 * someone else's CDN. Reimplemented here, badly but locally.
 */
function textSummary(summary) {
  const lines = [''];
  const metrics = summary.metrics || {};
  const fmt = (n) => (n === undefined ? '-' : `${n.toFixed(2)}ms`);

  /**
   * Dispatch on `metric.type`, not on which keys happen to be present. A k6
   * counter's `values` carries BOTH `count` and `rate`, so sniffing for `rate`
   * first prints "498 debits" as "121.18%" — which it did, until this was fixed.
   */
  const show = (name, label) => {
    const m = metrics[name];
    const pad = label.padEnd(26);

    // A counter that never incremented is absent from the summary entirely.
    // Printing 0 is more useful than printing nothing: "refused: 0" is a
    // result, a missing line is ambiguous.
    if (!m) {
      lines.push(`${pad} 0`);
      return;
    }

    switch (m.type) {
      case 'counter':
        lines.push(`${pad} ${m.values.count}`);
        return;
      case 'trend': {
        const v = m.values;
        lines.push(
          `${pad} min=${fmt(v.min)} med=${fmt(v.med)} p95=${fmt(v['p(95)'])} p99=${fmt(v['p(99)'])} max=${fmt(v.max)}`,
        );
        return;
      }
      case 'rate':
        lines.push(
          `${pad} ${(m.values.rate * 100).toFixed(2)}% (${m.values.passes} pass / ${m.values.fails} fail)`,
        );
        return;
      default:
        lines.push(`${pad} ${JSON.stringify(m.values)}`);
    }
  };

  lines.push(`--- ${MODE} · ${VUS} VUs · opening ${OPENING} · debit ${DEBIT} ---`);
  lines.push('');
  lines.push('counts');
  show('debits_applied', '  applied (200)');
  show('debits_refused', '  refused (422)');
  show('debits_failed', '  failed (other)');
  show('http_reqs', '  http requests');
  lines.push('');
  lines.push('latency');
  show('http_req_duration', '  http_req_duration');
  show('barrier_skew_ms', '  barrier skew');
  lines.push('');
  lines.push('checks');
  show('checks', '  passed');
  lines.push('');

  return lines.join('\n');
}
