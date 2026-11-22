/**
 * Evidence 13: live push vs polling — delivery latency and request volume.
 *
 *   npm run dev:exchange && npm run dev:workers    # API on $API, live push on
 *   node load/live-push.mjs
 *
 * Latency: one guest places ORDERS market orders over HTTP, one a second.
 * Each fill's event is timed from the moment the money moved (the outbox
 * row's `created_at`, carried in the event) to its arrival
 *   - on the SSE stream, and
 *   - in GET /v1/exchange/activity, polled every 2 s as the web app does.
 * Client and server share one clock (same box), so no skew correction.
 *
 * Volume: CLIENTS simulated viewers of the Trade page for SECONDS, first in
 * polling mode, then in push mode, making exactly the requests the web app's
 * query hooks make in each mode (apps/web/src/api/queries.ts): polling —
 * market 1 s, candles 1 s, me 2 s, activity 2 s, orders 5 s, fills 5 s;
 * push — the stream, candles 1 s, orders 5 s, fills 5 s, notifications 60 s.
 * Counts are client-side and cross-checked with the API's request counter.
 */
process.env.DATABASE_URL ??= 'postgres://daftar:daftar@127.0.0.1:55432/daftar_exchange';
const { createPool } = await import('../apps/api/src/db/pool.ts');
const { createGuest } = await import('../apps/api/src/exchange/participants.ts');
const { GUEST_COOKIE, issueGuestToken } = await import('../apps/api/src/exchange/session.ts');
const { env } = await import('../apps/api/src/env.ts');

const API = process.env.API ?? 'http://127.0.0.1:3100';
const ORDERS = Number(process.env.ORDERS ?? 30);
const CLIENTS = Number(process.env.CLIENTS ?? 50);
const SECONDS = Number(process.env.SECONDS ?? 30);
const pool = createPool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  applicationName: 'daftar-load-push',
});

const newCookie = async () => {
  const g = await createGuest(pool);
  return `${GUEST_COOKIE}=${issueGuestToken(env.GUEST_SESSION_SECRET, g.externalId)}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pctl = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function openStream(cookie, onFrame) {
  const ctrl = new AbortController();
  const res = await fetch(`${API}/v1/exchange/stream`, {
    headers: { cookie },
    signal: ctrl.signal,
  });
  if (res.status !== 200) throw new Error(`stream ${res.status}`);
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const f = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /event: (\S+)/.exec(f)?.[1];
          const data = /data: (.*)/.exec(f)?.[1];
          if (ev) onFrame(ev, data, Date.now());
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return () => ctrl.abort();
}

const requestsTotal = async () => {
  const text = await (await fetch(`${API}/metrics`)).text();
  let sum = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('daftar_http_request_duration_seconds_count'))
      sum += Number(line.split(' ').at(-1));
  }
  return sum;
};

/* ---------------------------------------------------------------- latency */
const cookie = await newCookie();
const pushLatency = [];
const pollLatency = [];
const seenByPoll = new Set();
const close = await openStream(cookie, (ev, data, at) => {
  if (ev !== 'activity') return;
  const { occurredAt, replayed } = JSON.parse(data);
  if (!replayed) pushLatency.push(at - Date.parse(occurredAt));
});
let polling = true;
const poller = (async () => {
  while (polling) {
    const res = await fetch(`${API}/v1/exchange/activity?limit=50`, { headers: { cookie } });
    const at = Date.now();
    const body = await res.json();
    for (const e of body.events ?? []) {
      if (seenByPoll.has(e.id)) continue;
      seenByPoll.add(e.id);
      pollLatency.push(at - Date.parse(e.occurredAt));
    }
    await sleep(2000);
  }
})();
await sleep(2500); // let the poller see the empty feed first
for (let i = 0; i < ORDERS; i++) {
  await fetch(`${API}/v1/exchange/orders`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'market',
      clientOrderId: `push-${Date.now()}-${String(i)}`,
      side: i % 2 === 0 ? 'buy' : 'sell',
      quantity: '0.01000000',
    }),
  });
  await sleep(1000);
}
await sleep(5000);
polling = false;
await poller;
close();

/* ---------------------------------------------------------------- volume */
const cookies = [];
for (let i = 0; i < CLIENTS; i++) cookies.push(await newCookie());

async function simulate(mode) {
  let made = 0;
  const stops = [];
  const every = (ms, path, c) => {
    const t = setInterval(() => {
      made += 1;
      fetch(`${API}${path}`, { headers: { cookie: c } })
        .then((r) => r.arrayBuffer())
        .catch(() => undefined);
    }, ms);
    stops.push(() => clearInterval(t));
  };
  let pushed = 0;
  for (const c of cookies) {
    every(1000, '/v1/exchange/candles?interval=1m&limit=240', c);
    every(5000, '/v1/exchange/orders?status=all&limit=100', c);
    every(5000, '/v1/exchange/fills?limit=200', c);
    if (mode === 'poll') {
      every(1000, '/v1/exchange/market?depth=15&tape=40', c);
      every(2000, '/v1/exchange/me', c);
      every(2000, '/v1/exchange/activity?limit=100', c);
    } else {
      made += 1; // the stream itself
      stops.push(await openStream(c, (ev) => ev === 'market' && (pushed += 1)));
      every(60_000, '/v1/exchange/notifications?limit=30', c);
    }
  }
  const before = await requestsTotal();
  const t = Date.now();
  await sleep(SECONDS * 1000);
  const after = await requestsTotal();
  stops.forEach((s) => s());
  return {
    made,
    serverCounted: after - before,
    perMinute: Math.round(((after - before) / ((Date.now() - t) / 1000)) * 60),
    pushed,
  };
}

const poll = await simulate('poll');
await sleep(2000);
const push = await simulate('push');

process.stdout.write(
  `latency, money moved → client sees it (ms), ${ORDERS} orders:\n` +
    `  push: n=${pushLatency.length} p50 ${pctl(pushLatency, 50)} p95 ${pctl(pushLatency, 95)} max ${Math.max(...pushLatency)}\n` +
    `  poll (2 s): n=${pollLatency.length} p50 ${pctl(pollLatency, 50)} p95 ${pctl(pollLatency, 95)} max ${Math.max(...pollLatency)}\n` +
    `volume, ${CLIENTS} viewers for ${SECONDS} s (server-counted requests; client-made in brackets):\n` +
    `  polling: ${poll.serverCounted} (${poll.made}) — ${poll.perMinute}/min\n` +
    `  push:    ${push.serverCounted} (${push.made}) — ${push.perMinute}/min; market snapshots pushed: ${push.pushed}\n`,
);
await pool.end();
