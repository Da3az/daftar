/**
 * Evidence 12: the withdrawal saga under a misbehaving payout rail.
 *
 *   npm run dev:workers            # the rail jobs and the dispatcher consumer
 *   node load/withdrawal-chaos.mjs
 *
 * Opens N withdrawals through `requestWithdrawal()` — the function the HTTP
 * route calls; the route is limited to 30 cash movements a minute per address
 * — with the simulated rail set to time out after succeeding, drop, and
 * reject a share of submissions. Waits until every withdrawal is finished, then
 * checks the money: no withdrawal paid out twice, every hold empty, every
 * returned withdrawal's cash back.
 *
 * Env: DATABASE_URL, N, TBS (timeout-but-succeeded %), DROP, REJECT.
 */
process.env.DATABASE_URL ??= 'postgres://daftar:daftar@127.0.0.1:55432/daftar_exchange';
const { createPool } = await import('../apps/api/src/db/pool.ts');
const { createGuest, findParticipant } = await import('../apps/api/src/exchange/participants.ts');
const { requestWithdrawal } = await import('../apps/api/src/exchange/withdrawals.ts');
const { setRailChaos } = await import('../apps/api/src/exchange/rail.ts');
const { checkHoldBalances } = await import('../apps/api/src/events/consumers/reconciler.ts');

const N = Number(process.env.N ?? 60);
const chaos = {
  timeoutButSucceededPct: Number(process.env.TBS ?? 20),
  dropPct: Number(process.env.DROP ?? 20),
  rejectPct: Number(process.env.REJECT ?? 10),
  latencyMs: 50,
  confirmAfterMs: 2000,
};
const pool = createPool({
  connectionString: process.env.DATABASE_URL,
  max: 6,
  applicationName: 'daftar-load-wd',
});
const q = async (sql, args = []) => (await pool.query(sql, args)).rows;

await setRailChaos(pool, chaos);
const startId = BigInt((await q('SELECT coalesce(max(id), 0)::text AS id FROM withdrawals'))[0].id);
const fundingBefore = BigInt(
  (await q(`SELECT balance::text FROM accounts WHERE external_id = 'external:funding'`))[0]
    ?.balance ?? '0',
);

const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const created = await createGuest(pool);
  const g = await findParticipant(pool, created.externalId);
  // 10.00 to 99.00, all under the review threshold: this run is about the rail.
  const amount = BigInt(1000 + ((i * 137) % 9000));
  const r = await requestWithdrawal(pool, {
    mover: g,
    externalId: `${g.externalId}:chaos-${String(i)}`,
    amount,
    reviewThreshold: 500_000n,
  });
  if (r.status !== 'requested') throw new Error(`request ${i}: ${r.status}`);
}
process.stdout.write(`requested ${N} withdrawals with chaos ${JSON.stringify(chaos)}\n`);

for (let i = 0; i < 900; i++) {
  const rows = await q(
    `SELECT state, count(*)::int AS n FROM withdrawals WHERE id > $1::bigint GROUP BY state`,
    [startId.toString()],
  );
  const open = rows
    .filter((r) => !['confirmed', 'released'].includes(r.state))
    .reduce((a, r) => a + r.n, 0);
  if (open === 0) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const [money] = await q(
  `SELECT
     count(*) FILTER (WHERE state = 'confirmed')::int AS confirmed,
     count(*) FILTER (WHERE state = 'released')::int AS released,
     count(*) FILTER (WHERE state NOT IN ('confirmed', 'released'))::int AS unfinished,
     coalesce(sum(amount) FILTER (WHERE state = 'confirmed'), 0)::text AS paid_out,
     max(submit_attempts)::int AS max_attempts,
     round(avg(submit_attempts), 2)::text AS avg_attempts
   FROM withdrawals WHERE id > $1::bigint`,
  [startId.toString()],
);
// A payout is a `payout` ledger transaction debiting a hold account.
const [payouts] = await q(
  `SELECT count(*)::int AS payout_txs, count(DISTINCT w.id)::int AS withdrawals_paid
     FROM withdrawals w
     JOIN entries e ON e.account_id = w.hold_account_id AND e.amount < 0
     JOIN ledger_transactions t ON t.id = e.transaction_id AND t.kind = 'payout'
    WHERE w.id > $1::bigint`,
  [startId.toString()],
);
const [rail] = await q(
  `SELECT count(*)::int AS payments,
          count(*) FILTER (WHERE r.status = 'confirmed')::int AS rail_confirmed,
          count(*) FILTER (WHERE r.status = 'rejected')::int AS rail_rejected
     FROM sim_rail_payments r JOIN withdrawals w ON w.rail_reference = r.reference
    WHERE w.id > $1::bigint`,
  [startId.toString()],
);
const [returned] = await q(
  `SELECT count(*)::int AS not_returned FROM withdrawals w
     JOIN participants p ON p.id = w.participant_id
     JOIN accounts a ON a.id = p.cash_account_id
    WHERE w.id > $1::bigint AND w.state = 'released' AND a.balance <> 1000000`,
  [startId.toString()],
);
const [holds] = await q(
  `SELECT count(*) FILTER (WHERE a.balance <> 0)::int AS nonzero_holds FROM withdrawals w
     JOIN accounts a ON a.id = w.hold_account_id WHERE w.id > $1::bigint`,
  [startId.toString()],
);
const durations = (
  await q(
    `SELECT (extract(epoch FROM max(t.at) - min(t.at)) * 1000)::int AS ms
       FROM withdrawal_transitions t WHERE t.withdrawal_id > $1::bigint GROUP BY t.withdrawal_id`,
    [startId.toString()],
  )
)
  .map((r) => r.ms)
  .sort((a, b) => a - b);
const pct = (p) =>
  durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))];
const fundingAfter = BigInt(
  (await q(`SELECT balance::text FROM accounts WHERE external_id = 'external:funding'`))[0].balance,
);
const transitions = await q(
  `SELECT from_state || ' → ' || to_state AS step, count(*)::int AS n FROM withdrawal_transitions
    WHERE withdrawal_id > $1::bigint AND from_state IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`,
  [startId.toString()],
);
const holdFindings = await checkHoldBalances(pool);

process.stdout.write(
  `finished in ${elapsed} s: ${JSON.stringify(money)}\n` +
    `payout ledger transactions ${payouts.payout_txs} for ${payouts.withdrawals_paid} withdrawals paid\n` +
    `rail: ${JSON.stringify(rail)}\n` +
    `external:funding moved by ${(fundingAfter - fundingBefore).toString()} (paid out ${money.paid_out})\n` +
    `released withdrawals whose cash did not come back: ${returned.not_returned}; non-zero holds: ${holds.nonzero_holds}; hold findings: ${holdFindings}\n` +
    `request → final: p50 ${pct(50)} ms, p95 ${pct(95)} ms, max ${durations[durations.length - 1]} ms\n` +
    `transitions:\n${transitions.map((t) => `  ${t.step}  ${t.n}`).join('\n')}\n`,
);
await setRailChaos(pool, {
  timeoutButSucceededPct: 0,
  dropPct: 0,
  rejectPct: 0,
  latencyMs: 50,
  confirmAfterMs: 5000,
});
await pool.end();
