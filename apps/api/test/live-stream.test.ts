import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { buildApp, type App } from '../src/app.ts';
import { env } from '../src/env.ts';
import type { LiveHub, LiveSink } from '../src/events/hub.ts';
import { createGuest, findParticipant } from '../src/exchange/participants.ts';
import { GUEST_COOKIE, issueGuestToken } from '../src/exchange/session.ts';
import { useTestDatabase } from './support/test-database.ts';
import { resetLedger } from './support/reset.ts';

/**
 * Live push. Rule under test (from the spec): a stream that reconnects with
 * `Last-Event-ID` receives every event it missed, exactly once, and then the
 * live ones — including those that arrived while the gap was being replayed.
 * And: a stream is refused (so the client polls) while the hub cannot read the
 * broker.
 *
 * The hub is an in-memory stand-in with the real interface, so this needs no
 * broker: what is tested is the route's subscribe → replay → dedupe logic,
 * against real PostgreSQL.
 */

const ctx = useTestDatabase({ poolMax: 6 });

class FakeHub implements LiveHub {
  sinks = new Set<LiveSink>();
  up = true;
  subscribe(sink: LiveSink) {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }
  latestMarket() {
    return null;
  }
  healthy() {
    return this.up;
  }
  connections() {
    return this.sinks.size;
  }
  async stop() {}
  emit(accountId: string, id: bigint) {
    for (const s of this.sinks) {
      if (s.accountId === accountId) {
        s.send(
          'activity',
          JSON.stringify({
            id: id.toString(),
            type: 'trade.buy',
            occurredAt: new Date().toISOString(),
          }),
          id.toString(),
        );
      }
    }
  }
}

const hub = new FakeHub();
let app: App;
let base = '';

beforeAll(async () => {
  app = await buildApp({ pool: ctx.pool, live: hub, loggerOverride: pino({ level: 'silent' }) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? String(addr.port) : '0'}`;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetLedger(ctx.pool);
  hub.up = true;
});

async function guestWithFeed(ids: number[]) {
  const created = await createGuest(ctx.pool);
  const g = (await findParticipant(ctx.pool, created.externalId))!;
  for (const id of ids) {
    await ctx.pool.query(
      `INSERT INTO exchange_activity (participant_id, outbox_event_id, event_type, payload, occurred_at)
       VALUES ($1::bigint, $2::bigint, 'trade.buy', '{}', now())`,
      [g.id.toString(), String(id)],
    );
  }
  return {
    g,
    cookie: `${GUEST_COOKIE}=${issueGuestToken(env.GUEST_SESSION_SECRET, created.externalId)}`,
  };
}

/** Read `activity` ids off a stream until `count` arrive or `ms` pass. */
async function readIds(
  res: Response,
  count: number,
  ms: number,
  onOpen?: () => void,
): Promise<string[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const ids: string[] = [];
  let buf = '';
  // Cancelling the reader ends a pending read() with `done`: the deadline.
  const timer = setTimeout(() => void reader.cancel().catch(() => undefined), ms);
  onOpen?.();
  while (ids.length < count) {
    const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (/event: activity/.test(frame)) ids.push(/id: (\d+)/.exec(frame)![1]!);
    }
  }
  clearTimeout(timer);
  await reader.cancel().catch(() => undefined);
  return ids;
}

describe('resuming a stream', () => {
  it('replays exactly the missed events, then the live ones, with no duplicates', async () => {
    const { g, cookie } = await guestWithFeed([10, 11, 12, 13]);
    const res = await fetch(`${base}/v1/exchange/stream`, {
      headers: { cookie, 'last-event-id': '11' },
    });
    expect(res.status).toBe(200);

    const ids = await readIds(res, 3, 3_000, () => {
      // Live traffic while the backlog is being sent: a duplicate of a
      // replayed event, and a new one.
      setTimeout(() => {
        hub.emit(g.cashAccountId.toString(), 13n);
        hub.emit(g.cashAccountId.toString(), 14n);
      }, 50);
    });
    expect(ids).toEqual(['12', '13', '14']);
  });

  it('without Last-Event-ID, sends only what happens from now on', async () => {
    const { g, cookie } = await guestWithFeed([10, 11]);
    const res = await fetch(`${base}/v1/exchange/stream`, { headers: { cookie } });
    const ids = await readIds(res, 1, 2_000, () =>
      setTimeout(() => hub.emit(g.cashAccountId.toString(), 15n), 100),
    );
    expect(ids).toEqual(['15']);
  });
});

describe('when the hub cannot read the broker', () => {
  it('refuses the stream with 503, so the client keeps polling', async () => {
    const { cookie } = await guestWithFeed([]);
    hub.up = false;
    const res = await fetch(`${base}/v1/exchange/stream`, { headers: { cookie } });
    expect(res.status).toBe(503);
    await res.body?.cancel();
  });
});
