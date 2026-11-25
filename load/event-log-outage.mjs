/**
 * Evidence 11: stop the broker under load; trading must continue, the outbox
 * must back up and drain, and no event may be lost.
 *
 *   npm run broker:up && npm run dev:exchange && npm run dev:workers   # API on $API
 *   node load/event-log-outage.mjs
 *
 * Guests are created directly and trade by calling `placeBookOrder()` — the
 * function the HTTP order route calls — rather than over HTTP: the route is
 * rate limited to 120 orders a minute per address, and the first run of this
 * script measured the rate limiter (747 of 987 orders got 429) instead of the
 * matching path. The Kafka broker is stopped with `docker stop` at STOP_AT s
 * and started again at START_AT s.
 *
 * Env: DATABASE_URL (daftar_exchange),
 * GUESTS, RATE (orders/s), DURATION_S, STOP_AT, START_AT.
 */
import { execFileSync } from 'node:child_process';

process.env.DATABASE_URL ??= 'postgres://daftar:daftar@127.0.0.1:55432/daftar_exchange';
const { createGuest } = await import('../apps/api/src/exchange/participants.ts');
const { placeBookOrder, DEFAULT_MARKET } = await import('../apps/api/src/exchange/engine.ts');
const { createPool } = await import('../apps/api/src/db/pool.ts');
const GUESTS = Number(process.env.GUESTS ?? 20);
const RATE = Number(process.env.RATE ?? 10);
const DURATION_S = Number(process.env.DURATION_S ?? 100);
const STOP_AT = Number(process.env.STOP_AT ?? 20);
const START_AT = Number(process.env.START_AT ?? 50);

// The app's own pool factory: it registers the bigint type parser the engine relies on.
const pool = createPool({
  connectionString: process.env.DATABASE_URL,
  max: 12,
  applicationName: 'daftar-load-outage',
});
const q = async (sql, args = []) => (await pool.query(sql, args)).rows;

const startId = BigInt((await q('SELECT coalesce(max(id), 0)::text AS id FROM outbox'))[0].id);
const guests = [];
for (let i = 0; i < GUESTS; i++) {
  const g = await createGuest(pool);
  guests.push(g.externalId);
}

const outcomes = {};
let sent = 0;
const place = async (participant, side) => {
  try {
    const result = await placeBookOrder(pool, {
      externalId: `${participant}:outage-${String(sent)}-${Math.random().toString(36).slice(2, 8)}`,
      participantExternalId: participant,
      symbol: DEFAULT_MARKET,
      side,
      type: 'market',
      quantity: 1_000_000n, // 0.01 coin
    });
    const key = result.status === 'accepted' ? 'filled' : result.status;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  } catch {
    outcomes.error = (outcomes.error ?? 0) + 1;
  }
};

const t0 = Date.now();
const samples = [];
const docker = (verb) => execFileSync('docker', [verb, 'daftar-kafka'], { stdio: 'ignore' });
let stopped = false;
let started = false;

const sampler = setInterval(async () => {
  const s = Math.round((Date.now() - t0) / 1000);
  const [lag] = await q(
    `SELECT count(*) FILTER (WHERE state = 'pending')::int AS pending,
            count(*) FILTER (WHERE state = 'in_flight')::int AS in_flight,
            count(*) FILTER (WHERE state = 'dead')::int AS dead,
            coalesce(extract(epoch FROM now() - min(created_at) FILTER (WHERE state <> 'published')), 0)::int AS oldest_s
       FROM outbox WHERE id > $1::bigint`,
    [startId.toString()],
  );
  samples.push({ s, filled: outcomes.filled ?? 0, ...lag });
}, 1000);

while ((Date.now() - t0) / 1000 < DURATION_S) {
  const elapsed = (Date.now() - t0) / 1000;
  if (!stopped && elapsed >= STOP_AT) {
    docker('stop');
    stopped = true;
    process.stdout.write(`t=${elapsed.toFixed(1)}s broker stopped\n`);
  }
  if (!started && elapsed >= START_AT) {
    docker('start');
    started = true;
    process.stdout.write(`t=${elapsed.toFixed(1)}s broker started\n`);
  }
  // Each guest buys then sells, so it always has the coin it sells.
  const guest = guests[Math.floor(sent / 2) % guests.length];
  void place(guest, sent % 2 === 0 ? 'buy' : 'sell');
  sent += 1;
  await new Promise((r) => setTimeout(r, 1000 / RATE));
}
process.stdout.write(`load stopped at t=${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

// Drain: wait for the outbox to empty and the feed to catch up.
const loadEnd = Date.now();
let drainedAt = null;
for (let i = 0; i < 600; i++) {
  const [r] = await q(
    `SELECT (SELECT count(*) FROM outbox WHERE id > $1::bigint AND state <> 'published')::int AS unpublished,
            (SELECT count(*) FROM outbox WHERE id > $1::bigint)::int AS events,
            (SELECT count(*) FROM exchange_activity WHERE outbox_event_id > $1::bigint)::int AS delivered`,
    [startId.toString()],
  );
  if (r.unpublished === 0 && r.delivered >= r.events) {
    drainedAt = Date.now();
    break;
  }
  await new Promise((x) => setTimeout(x, 1000));
}
clearInterval(sampler);

const [final] = await q(
  `SELECT (SELECT count(*) FROM outbox WHERE id > $1::bigint)::int AS events,
          (SELECT count(*) FROM outbox WHERE id > $1::bigint AND state = 'dead')::int AS dead,
          (SELECT count(*) FROM exchange_activity WHERE outbox_event_id > $1::bigint)::int AS delivered,
          (SELECT count(*) FROM outbox o WHERE o.id > $1::bigint
              AND NOT EXISTS (SELECT 1 FROM exchange_activity a WHERE a.outbox_event_id = o.id))::int AS missing,
          (SELECT max(attempts) FROM outbox WHERE id > $1::bigint)::int AS max_attempts`,
  [startId.toString()],
);
// Recovery: from the broker starting to the backlog being back to its steady
// state (at most 5 rows — what one relay cycle has in hand under this load).
const recovered = samples.find((s) => s.s > START_AT && s.pending + s.in_flight <= 5);
const peak = samples.reduce(
  (a, s) => (s.pending + s.in_flight > a.pending + a.in_flight ? s : a),
  samples[0],
);
const during = samples.filter((s) => s.s >= STOP_AT && s.s < START_AT);
const filledDuring = during.length ? during[during.length - 1].filled - during[0].filled : 0;

process.stdout.write(
  '\nper-second samples (s, filled orders so far, pending, in_flight, dead, oldest unpublished s):\n',
);
for (const s of samples)
  process.stdout.write(
    `${s.s}\t${s.filled}\t${s.pending}\t${s.in_flight}\t${s.dead}\t${s.oldest_s}\n`,
  );
process.stdout.write(
  `\norders sent ${sent}; outcomes ${JSON.stringify(outcomes)}\n` +
    `orders filled while the broker was down: ${filledDuring} over ${during.length} s\n` +
    `peak outbox backlog: ${peak.pending + peak.in_flight} rows at t=${peak.s}s (oldest ${peak.oldest_s} s)\n` +
    `backlog back to steady state ${recovered ? recovered.s - START_AT : 'NEVER'} s after the broker started (1 s sampling)\n` +
    `drain after load stopped: ${drainedAt ? ((drainedAt - loadEnd) / 1000).toFixed(1) : 'DID NOT DRAIN'} s\n` +
    `events written ${final.events}; delivered to the feed ${final.delivered}; missing ${final.missing}; dead ${final.dead}; max attempts used ${final.max_attempts}\n`,
);
await pool.end();
