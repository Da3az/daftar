/**
 * Evidence 11 (part): how long a projection/ledger divergence goes unnoticed.
 *
 *   node load/reconcile-ttd.mjs            # API and workers running
 *
 * Corrupts N positions through POST /v1/admin/chaos/projection-drift (the
 * projection only — never the ledger), waits for the reconciler's findings,
 * and reports detected_at − injected_at. No new trades touch the corrupted
 * positions, so detection comes from the periodic full sweep, the slow path.
 */
import pg from 'pg';

const API = process.env.API ?? 'http://127.0.0.1:3100';
const TOKEN = process.env.ADMIN_TOKEN ?? '';
const N = Number(process.env.N ?? 5);
const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://daftar:daftar@127.0.0.1:55432/daftar_exchange',
  max: 2,
});

const { rows: targets } = await pool.query(
  `SELECT p.handle FROM proj_positions pp JOIN participants p ON p.id = pp.participant_id
    WHERE p.kind = 'guest' AND pp.quantity > 0 AND p.handle IS NOT NULL
    ORDER BY random() LIMIT $1`,
  [N],
);
const ids = [];
for (const t of targets) {
  const res = await fetch(`${API}/v1/admin/chaos/projection-drift`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ handle: t.handle, symbol: 'DFT', field: 'cost_basis', delta: '13' }),
  });
  const body = await res.json();
  if (res.status !== 200) throw new Error(`inject failed: ${res.status} ${JSON.stringify(body)}`);
  ids.push(body.injectionId);
}
process.stdout.write(`injected ${ids.length} drifts\n`);

const deadline = Date.now() + 180_000;
let rows = [];
while (Date.now() < deadline) {
  ({ rows } = await pool.query(
    `SELECT id, (extract(epoch FROM detected_at - injected_at) * 1000)::int AS ttd_ms
       FROM projection_drift_injections WHERE id = ANY($1::bigint[])`,
    [ids],
  ));
  if (rows.every((r) => r.ttd_ms !== null)) break;
  await new Promise((r) => setTimeout(r, 500));
}
const ttd = rows
  .map((r) => r.ttd_ms)
  .filter((x) => x !== null)
  .sort((a, b) => a - b);
process.stdout.write(
  `detected ${ttd.length}/${ids.length}; time-to-detect ms: ${ttd.join(', ')}\n`,
);
process.stdout.write(
  `min ${ttd[0]} ms, median ${ttd[Math.floor(ttd.length / 2)]} ms, max ${ttd[ttd.length - 1]} ms\n`,
);
await pool.end();
