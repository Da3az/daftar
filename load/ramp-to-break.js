import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * # Ramp to the breaking point
 *
 * Phase 10's harness. Unlike `orders-bench.js`, which measures one fixed
 * concurrency level, this one steps the virtual-user count up until the SLO
 * breaks and keeps measuring past it.
 *
 * ## Per-stage metrics, not one aggregate
 *
 * Every metric below is tagged with `stage`, the virtual-user count of the step
 * it was recorded in. A single p99 across the whole ramp is meaningless — it
 * mixes an idle warm-up with a saturated tail and lands somewhere that
 * describes neither.
 *
 * ## `ramping-vus`, and the 45-second steps
 *
 * `ramping-arrival-rate` would hold a target request rate regardless of
 * latency, which is the right executor for an open model. This uses closed-loop
 * `ramping-vus` on purpose: the SLO is stated at a **concurrent user** count
 * ("p99 under 200 ms at 50 concurrent VUs"), so the measurement has to vary the
 * same quantity the SLO names.
 *
 * 45 s per step with a 10 s ramp into it. The first few seconds of a step are
 * the pool growing and the plan cache warming, and including them drags the
 * step's p99 toward the transition rather than the steady state. `STEADY_AFTER`
 * marks the point after which samples count.
 */

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const MODE = __ENV.MODE || 'advisory';
const SPREAD = Number(__ENV.SPREAD || 1000);
const SYMBOL = __ENV.SYMBOL || 'BTC';
const LABEL = __ENV.LABEL || 'baseline';

/** The ramp. Doubling, so the break point is bracketed rather than crept up on. */
const STEPS = (__ENV.STEPS || '25,50,100,200,400,800').split(',').map(Number);
const STEP_SECONDS = Number(__ENV.STEP_SECONDS || 45);
const RAMP_SECONDS = Number(__ENV.RAMP_SECONDS || 10);

/** Ignore the first N seconds of each step — see the note above. */
const STEADY_AFTER = Number(__ENV.STEADY_AFTER || 15);

const placed = new Counter('orders_placed');
const refused = new Counter('orders_refused');
const failed = new Counter('orders_failed');
const retries = new Counter('ledger_retries');
const orderDuration = new Trend('order_duration_ms', true);
const errorRate = new Rate('order_error_rate');

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      // `maxVUs` is implicit for ramping-vus (it is the highest stage target),
      // but the stages have to be built so each plateau is preceded by its own
      // ramp — otherwise k6 interpolates linearly across the whole run and
      // there are no plateaus to measure.
      stages: STEPS.flatMap((vus) => [
        { duration: `${String(RAMP_SECONDS)}s`, target: vus },
        { duration: `${String(STEP_SECONDS)}s`, target: vus },
      ]),
      gracefulRampDown: '5s',
      gracefulStop: '15s',
    },
  },
  /**
   * ## Thresholds exist here to *create* the sub-metrics, not to fail the run
   *
   * k6 only materialises a tagged sub-metric if something references it, and a
   * threshold is the only way to reference one up front. Without these,
   * `summary.metrics` contains one aggregate per metric and the per-stage table
   * below has nothing to read — which is the whole output.
   *
   * Every threshold is trivially true (`p(99) >= 0`), and none aborts. The
   * point of this run is to record the collapse; a threshold that killed it
   * would discard the measurement it was meant to protect.
   */
  thresholds: Object.fromEntries(
    STEPS.flatMap((vus) => [
      [`order_duration_ms{stage:${String(vus)},steady:yes}`, ['p(99)>=0']],
      [`orders_placed{stage:${String(vus)},steady:yes}`, ['count>=0']],
      [`orders_refused{stage:${String(vus)},steady:yes}`, ['count>=0']],
      [`orders_failed{stage:${String(vus)},steady:yes}`, ['count>=0']],
      [`ledger_retries{stage:${String(vus)},steady:yes}`, ['count>=0']],
    ]),
  ),
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max', 'avg'],
  discardResponseBodies: false,
};

function accountFor(iteration) {
  return `seed-${String(iteration % SPREAD).padStart(6, '0')}`;
}

/**
 * Which step the clock is currently in, and how far into it.
 *
 * Derived from elapsed time rather than from the live VU count: at the moment
 * of a transition the VU count is between two targets, and tagging a sample
 * with "137 VUs" would put it in a bucket that no step corresponds to.
 */
function stageAt(elapsedSeconds) {
  let boundary = 0;
  for (const vus of STEPS) {
    const rampEnd = boundary + RAMP_SECONDS;
    const stepEnd = rampEnd + STEP_SECONDS;
    if (elapsedSeconds < stepEnd) {
      return {
        vus,
        // `false` during the ramp and the early part of the plateau.
        steady: elapsedSeconds >= rampEnd + STEADY_AFTER,
      };
    }
    boundary = stepEnd;
  }
  return { vus: STEPS[STEPS.length - 1], steady: true };
}

export function setup() {
  const probe = http.get(`${BASE_URL}/v1/accounts/${accountFor(0)}`);
  if (probe.status !== 200) {
    throw new Error(
      `account ${accountFor(0)} not found (${probe.status}). Run: npm run seed -- --entries 10000000 --customers 2000`,
    );
  }

  const last = http.get(`${BASE_URL}/v1/accounts/${accountFor(SPREAD - 1)}`);
  if (last.status !== 200) {
    throw new Error(`the seed has fewer than SPREAD=${SPREAD} customers (${last.status}).`);
  }

  // Per-run nonce. Without it the second run collides with order ids the first
  // left behind, and every collision is a 409 counted as a failure — a fake
  // failure rate that looks like a server problem. This cost real time once.
  const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const total = STEPS.length * (RAMP_SECONDS + STEP_SECONDS);

  console.log(
    `[setup] label=${LABEL} mode=${MODE} spread=${SPREAD} steps=${STEPS.join('/')} ` +
      `~${total}s total run=${runId}`,
  );

  return { startedAt: Date.now(), runId };
}

export default function (data) {
  const elapsed = (Date.now() - data.startedAt) / 1000;
  const stage = stageAt(elapsed);

  // Samples outside the steady window are still *issued* — dropping the
  // requests would change the load — but they are tagged so the analysis can
  // exclude them. Load and measurement are different concerns.
  const tags = {
    stage: String(stage.vus),
    steady: stage.steady ? 'yes' : 'no',
    mode: MODE,
    label: LABEL,
  };

  const iteration = exec.scenario.iterationInTest;
  const externalId = `ramp-${data.runId}-${exec.vu.idInTest}-${iteration}`;

  const started = Date.now();
  const res = http.post(
    `${BASE_URL}/v1/orders`,
    JSON.stringify({
      externalId,
      accountId: accountFor(iteration),
      symbol: SYMBOL,
      side: 'buy',
      quantity: '0.00100000',
    }),
    {
      headers: { 'Content-Type': 'application/json', 'x-daftar-concurrency-mode': MODE },
      tags,
      // Longer than the pool's 5s acquire timeout, so a request that is going
      // to fail on the pool fails *there* and is recorded as a 500 — rather
      // than being cut off by the client and recorded as a timeout, which would
      // hide which component actually broke.
      timeout: '30s',
    },
  );

  const elapsedMs = Date.now() - started;
  orderDuration.add(elapsedMs, tags);

  if (res.status === 201) {
    placed.add(1, tags);
    errorRate.add(false, tags);
    try {
      const attempts = JSON.parse(res.body).attempts;
      retries.add(attempts - 1, tags);
    } catch {
      // Caught by the error counters rather than swallowed.
    }
  } else if (res.status === 422) {
    // Insufficient funds. The *correct* answer, so not an error — but it does
    // mean the seeded balance ran out, which would invalidate the throughput
    // number. Counted separately so that is visible.
    refused.add(1, tags);
    errorRate.add(false, tags);
  } else {
    failed.add(1, tags);
    errorRate.add(true, tags);
  }
}

export function handleSummary(summary) {
  return {
    stdout: summarise(summary),
    [`load/out/ramp-${LABEL}.json`]: JSON.stringify(summary, null, 2),
  };
}

/**
 * A per-stage table, built from the tagged sub-metrics.
 *
 * k6's own `textSummary` prints one aggregate per metric, which for a ramp is
 * the one number that cannot be interpreted. This walks `summary.metrics` and
 * groups by the `stage` tag instead.
 */
function summarise(summary) {
  const lines = [''];
  lines.push(`  ramp: ${LABEL}  mode=${MODE}  spread=${SPREAD}`);
  lines.push('');
  lines.push('  VUs     ok  refused  failed   p50ms   p95ms   p99ms    maxms   ord/s   err%');
  lines.push('  ----  -----  -------  ------  ------  ------  ------  -------  ------  -----');

  for (const vus of STEPS) {
    const d = sub(summary, 'order_duration_ms', vus);
    const ok = count(summary, 'orders_placed', vus);
    const ref = count(summary, 'orders_refused', vus);
    const bad = count(summary, 'orders_failed', vus);

    // Throughput over the steady window only, and from successes only.
    // Counting failures as throughput is how a collapsing configuration
    // reports the best number in the table — which happened once, in Phase 3.
    const rate = ok / (STEP_SECONDS - STEADY_AFTER);
    const total = ok + ref + bad;
    const errPct = total === 0 ? 0 : (bad / total) * 100;

    const breached = (d?.['p(99)'] ?? 0) > 200;

    lines.push(
      '  ' +
        [
          String(vus).padStart(4),
          String(ok).padStart(5),
          String(ref).padStart(7),
          String(bad).padStart(6),
          fmt(d?.med).padStart(6),
          fmt(d?.['p(95)']).padStart(6),
          fmt(d?.['p(99)']).padStart(6) + (breached ? ' <<' : '   '),
          fmt(d?.max).padStart(7),
          rate.toFixed(0).padStart(6),
          errPct.toFixed(1).padStart(5),
        ].join('  '),
    );
  }

  lines.push('');
  lines.push('  `<<` marks a step whose p99 breached the 200ms SLO.');
  lines.push('  Steady window only: the first ' + String(STEADY_AFTER) + 's of each step is');
  lines.push('  excluded, because it is the pool growing rather than the steady state.');
  lines.push('');
  return lines.join('\n');
}

const fmt = (v) => (v === undefined || v === null ? '-' : v.toFixed(0));

/**
 * A tagged sub-metric's values, for one stage's steady window.
 *
 * Declared thresholds make k6 expose each sub-metric as its own **top-level
 * key** in `summary.metrics`, named `metric{tag:value,...}` — not nested under
 * the parent metric. Looking for a `submetrics` property on the parent finds
 * nothing and silently yields an empty table.
 */
function sub(summary, name, vus) {
  return summary.metrics[`${name}{stage:${String(vus)},steady:yes}`]?.values;
}

function count(summary, name, vus) {
  const values = sub(summary, name, vus);
  return values?.count ?? 0;
}
