/**
 * Phase 3 benchmark — three concurrency strategies at three contention profiles.
 *
 * Usage:
 *
 *   MODE=pessimistic SPREAD=1000 ./.tools/bin/k6 run load/orders-bench.js
 *
 * Environment:
 *   BASE_URL  default http://127.0.0.1:3000
 *   MODE      pessimistic | serializable | advisory
 *   SPREAD    number of distinct accounts the load is spread over (1, 10, 1000)
 *   VUS       default 50 — the SLO's figure
 *   DURATION  default 30s
 *   SYMBOL    default BTC
 *
 * ## Why `constant-vus` and not an arrival-rate executor
 *
 * The SLO is stated in terms of **concurrency**, not arrival rate: "p99 under
 * 200 ms at 50 concurrent virtual users". `constant-vus` holds 50 in flight and
 * lets throughput fall out of the system's actual speed, which is the quantity
 * being compared across strategies. An arrival-rate executor would instead hold
 * a fixed RPS and queue when the system could not keep up, so a slower strategy
 * would show the same throughput with a growing backlog — hiding exactly the
 * difference this benchmark exists to measure.
 *
 * `maxVUs` is worth naming even though it does not apply here: for
 * `constant-arrival-rate` and `ramping-arrival-rate` it defaults to
 * `preAllocatedVUs`, so a scenario targeting high throughput with a small
 * `preAllocatedVUs` silently caps there and reports a lower rate with no error.
 * `constant-vus` takes `vus` directly and has no such trap. Phase 10, which does
 * ramp to find a breaking point, uses an arrival-rate executor and sets it.
 *
 * ## The account spread is part of the SLO, not a footnote
 *
 * Under pessimistic locking on one hot account, throughput is bounded by lock
 * hold time, so the same build passes at 1000 accounts and fails at 1 — and
 * both runs are honestly described as "50 concurrent". Every number this script
 * prints carries its spread.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const MODE = __ENV.MODE || 'serializable';
const SPREAD = Number(__ENV.SPREAD || 1000);
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '30s';
const SYMBOL = __ENV.SYMBOL || 'BTC';

const MODES = ['pessimistic', 'serializable', 'advisory'];
if (!MODES.includes(MODE)) {
  throw new Error(`unknown MODE "${MODE}" — expected one of ${MODES.join(', ')}`);
}

const placed = new Counter('orders_placed');
const refused = new Counter('orders_refused');
const failed = new Counter('orders_failed');
/** Retries beyond the first attempt. Non-trivial only under `serializable`. */
const retries = new Counter('ledger_retries');
const attemptsTrend = new Trend('ledger_attempts');
const retriedRate = new Rate('orders_needing_retry');
const orderDuration = new Trend('order_duration_ms', true);

export const options = {
  scenarios: {
    orders: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      gracefulStop: '15s',
    },
  },
  // No aborting thresholds: this script records what happens, including a
  // strategy collapsing. A threshold that killed the run would discard the
  // measurement it was meant to protect.
  thresholds: {},
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max', 'avg'],
  discardResponseBodies: false,
};

/**
 * Which account this iteration targets.
 *
 * Spread deterministically across `SPREAD` accounts by iteration number rather
 * than at random: a random choice leaves the actual distribution to luck, and at
 * SPREAD=1 vs SPREAD=10 the whole result is the distribution.
 */
function accountFor(iteration) {
  const index = iteration % SPREAD;
  return `seed-${String(index).padStart(6, '0')}`;
}

export function setup() {
  // Fail loudly and early rather than producing a run of 404s that looks like a
  // latency result.
  const probe = http.get(`${BASE_URL}/v1/accounts/${accountFor(0)}`);
  if (probe.status !== 200) {
    throw new Error(
      `account ${accountFor(0)} not found (${probe.status}). Run: npm run seed -- --entries 10000000 --customers 2000`,
    );
  }

  const last = http.get(`${BASE_URL}/v1/accounts/${accountFor(SPREAD - 1)}`);
  if (last.status !== 200) {
    throw new Error(
      `account ${accountFor(SPREAD - 1)} not found (${last.status}). The seed has fewer than SPREAD=${SPREAD} customers.`,
    );
  }

  /**
   * A per-run nonce, mixed into every order's external id.
   *
   * Learned the hard way. Without it the id was
   * `bench-{mode}-{spread}-{vu}-{iteration}`, and iteration counters restart at
   * zero on every run — so the second pass over the benchmark matrix collided
   * with rows the first pass had left behind and took 409s on them. It showed up
   * as a 2-3% "failure rate" for `pessimistic` and `advisory` that looked like a
   * server problem and was entirely my harness reusing ids.
   *
   * Worth the paragraph because of how it presented: the server logs were clean
   * apart from genuine 40001s, so the failures appeared to come from nowhere.
   */
  const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

  console.log(`[setup] mode=${MODE} spread=${SPREAD} vus=${VUS} duration=${DURATION} run=${runId}`);
  return { startedAt: Date.now(), runId };
}

export default function (data) {
  const iteration = exec.scenario.iterationInTest;
  const account = accountFor(iteration);

  // Unique per order AND per run. The unique index on orders.external_id makes
  // any repeat a 409, which would be measured as a failure.
  const externalId = `bench-${data.runId}-${exec.vu.idInTest}-${iteration}`;

  const started = Date.now();
  const res = http.post(
    `${BASE_URL}/v1/orders`,
    JSON.stringify({
      externalId,
      accountId: account,
      symbol: SYMBOL,
      side: 'buy',
      // Small and fixed: the quantity is not the variable under test, and a
      // varying one would vary the notional and so the funds check.
      quantity: '0.00100000',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'x-daftar-concurrency-mode': MODE,
      },
      tags: { mode: MODE, spread: String(SPREAD) },
    },
  );
  orderDuration.add(Date.now() - started);

  if (res.status === 201) {
    placed.add(1);
    try {
      const attempts = JSON.parse(res.body).attempts;
      attemptsTrend.add(attempts);
      retries.add(attempts - 1);
      retriedRate.add(attempts > 1);
    } catch {
      // A 201 whose body does not parse is a real problem, caught by the check
      // below rather than swallowed here.
    }
  } else if (res.status === 422) {
    refused.add(1);
    retriedRate.add(false);
  } else {
    failed.add(1);
    retriedRate.add(false);
    if (failed.name) {
      console.error(`[vu ${exec.vu.idInTest}] ${res.status}: ${String(res.body).slice(0, 200)}`);
    }
  }

  check(res, {
    'not a server error': (r) => r.status < 500,
    'placed or refused': (r) => r.status === 201 || r.status === 422,
  });
}

export function handleSummary(summary) {
  return {
    stdout: textSummary(summary),
    [`load/out/orders-bench-${MODE}-${SPREAD}.json`]: JSON.stringify(summary, null, 2),
  };
}

/**
 * Local, not k6's jslib `textSummary`, which is fetched over the network at run
 * time. A measurement harness that depends on someone else's CDN can fail, or
 * silently change, between two runs that are supposed to be comparable.
 */
function textSummary(summary) {
  const m = summary.metrics || {};
  const lines = [''];

  const count = (name) => m[name]?.values.count ?? 0;
  const ms = (n) => (n === undefined ? '-' : `${n.toFixed(1)}ms`);

  const durations = m.http_req_duration?.values ?? {};
  const seconds = (summary.state?.testRunDurationMs ?? 0) / 1000;
  const ok = count('orders_placed');
  const bad = count('orders_failed');
  const total = ok + count('orders_refused') + bad;

  lines.push(`=== ${MODE} · spread ${SPREAD} account(s) · ${VUS} VUs · ${DURATION} ===`);
  lines.push('');

  /**
   * Throughput counts **successful** orders only.
   *
   * The first version of this summary divided placed+refused+failed by the
   * duration, and reported `serializable` at 801 orders/s while 88% of its
   * requests were 500s. Failing fast is not throughput. Keeping the attempted
   * rate alongside it is still useful — it is what the client observed — but
   * the headline number has to be work that actually landed.
   */
  lines.push(`throughput (placed)  ${seconds > 0 ? (ok / seconds).toFixed(1) : '-'} orders/s`);
  lines.push(`attempted            ${seconds > 0 ? (total / seconds).toFixed(1) : '-'} req/s`);
  lines.push(
    `success rate         ${total > 0 ? ((ok / total) * 100).toFixed(2) : '-'}%  (${bad} failed)`,
  );
  lines.push(`orders placed        ${ok}`);
  lines.push(`orders refused (422) ${count('orders_refused')}`);
  lines.push(`orders failed        ${bad}`);
  lines.push('');
  lines.push('NOTE latency below is over ALL requests including failures, so a');
  lines.push('     strategy that fails fast shows a flattering p99. Read it with');
  lines.push('     the success rate.');
  lines.push('');
  lines.push(`p50                  ${ms(durations.med)}`);
  lines.push(`p95                  ${ms(durations['p(95)'])}`);
  lines.push(`p99                  ${ms(durations['p(99)'])}`);
  lines.push(`max                  ${ms(durations.max)}`);
  lines.push('');
  lines.push(`ledger retries       ${count('ledger_retries')}`);

  const retryRate = m.orders_needing_retry?.values.rate;
  lines.push(
    `orders needing retry ${retryRate === undefined ? '-' : `${(retryRate * 100).toFixed(2)}%`}`,
  );

  const attempts = m.ledger_attempts?.values ?? {};
  lines.push(
    `attempts med/p99/max ${attempts.med ?? '-'} / ${attempts['p(99)'] ?? '-'} / ${attempts.max ?? '-'}`,
  );
  lines.push('');

  const checks = m.checks?.values;
  if (checks) {
    lines.push(`checks               ${(checks.rate * 100).toFixed(2)}% (${checks.fails} fail)`);
  }
  lines.push('');

  return lines.join('\n');
}
