import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from './support/test-database.ts';
import { resetLedger } from './support/reset.ts';
import {
  SHARD_COUNT,
  allShards,
  claimBatch,
  drainOnce,
  enqueue,
  lag,
  markFailed,
  publishAfterCommitNaive,
  reap,
  reclaimStale,
  shardsFor,
  type OutboxEvent,
  type Publisher,
} from '../src/outbox/worker.ts';
import { post } from '../src/ledger/post.ts';

const ctx = useTestDatabase({ poolMax: 20 });

let accountA: bigint;
let accountB: bigint;
let houseAccount: bigint;

beforeEach(async () => {
  await resetLedger(ctx.pool);

  const { rows } = await ctx.pool.query<{ id: bigint; external_id: string }>(
    `INSERT INTO accounts (external_id, kind, balance) VALUES
       ('ob-a', 'customer_cash', 1000000),
       ('ob-b', 'customer_cash', 1000000),
       ('ob-house', 'house_cash', 0)
     RETURNING id, external_id`,
  );
  const byName = new Map(rows.map((r) => [r.external_id, r.id]));
  accountA = byName.get('ob-a')!;
  accountB = byName.get('ob-b')!;
  houseAccount = byName.get('ob-house')!;
});

/** A publisher that records what it saw, in order. */
function recorder(): { publish: Publisher; seen: bigint[]; accounts: bigint[] } {
  const seen: bigint[] = [];
  const accounts: bigint[] = [];
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- Publisher is async
    publish: async (event) => {
      seen.push(event.id);
      accounts.push(event.accountId);
    },
    seen,
    accounts,
  };
}

const worker = (publish: Publisher, shards = allShards(), workerId = 'w1') => ({
  pool: ctx.pool,
  publish,
  shards,
  workerId,
});

/** Enqueue inside a real ledger transaction, as production does. */
async function postWithEvent(amount: bigint, accountId: bigint): Promise<bigint> {
  let outboxId = 0n;

  const result = await post(ctx.pool, {
    kind: 'adjustment',
    legs: [
      { accountId, amount: -amount },
      { accountId: houseAccount, amount },
    ],
    mode: 'pessimistic',
    withinTransaction: async (client, transactionId) => {
      outboxId = await enqueue(client, {
        transactionId,
        accountId,
        eventType: 'ledger.posted',
        payload: { transactionId: transactionId.toString(), amount: amount.toString() },
      });
    },
  });

  if (result.status !== 'posted') throw new Error(`expected posted, got ${result.status}`);
  return outboxId;
}

describe('the outbox row commits with the ledger entries', () => {
  it('a committed transaction leaves exactly one pending event', async () => {
    await postWithEvent(1000n, accountA);

    const { rows } = await ctx.pool.query<{ n: bigint; state: string }>(
      'SELECT count(*) AS n, min(state) AS state FROM outbox',
    );
    expect(rows[0]).toEqual({ n: 1n, state: 'pending' });
  });

  it('a ROLLED BACK transaction leaves NO event — one atomicity domain', async () => {
    /**
     * The property the whole pattern exists for. The outbox row is written by
     * the same transaction as the entries, so a failure takes both out. With a
     * dual write the event would already have been published.
     */
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: bigint }>(
        `INSERT INTO ledger_transactions (kind) VALUES ('adjustment') RETURNING id`,
      );
      await enqueue(client, {
        transactionId: rows[0]!.id,
        accountId: accountA,
        eventType: 'ledger.posted',
        payload: { nope: true },
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const { rows } = await ctx.pool.query<{ n: bigint }>('SELECT count(*) AS n FROM outbox');
    expect(rows[0]?.n).toBe(0n);
  });

  it('the foreign key makes the coupling checkable, not merely intended', async () => {
    // An outbox row cannot reference a transaction that was rolled back,
    // because the transaction row would not exist.
    await expect(
      ctx.pool.query(
        `INSERT INTO outbox (transaction_id, account_id, event_type, payload)
         VALUES (999999999, $1::bigint, 'x', '{}'::jsonb)`,
        [accountA.toString()],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('claim → commit → publish', () => {
  it('claims, publishes and marks published', async () => {
    const id = await postWithEvent(1000n, accountA);
    const rec = recorder();

    const result = await drainOnce(worker(rec.publish));

    expect(result).toEqual({ claimed: 1, published: 1, retried: 0, dead: 0 });
    expect(rec.seen).toEqual([id]);

    const { rows } = await ctx.pool.query<{ state: string; published_at: string }>(
      'SELECT state, published_at FROM outbox WHERE id = $1::bigint',
      [id.toString()],
    );
    expect(rows[0]?.state).toBe('published');
    expect(rows[0]?.published_at).not.toBe('infinity');
  });

  it('holds NO transaction open across the publish', async () => {
    /**
     * The property that keeps a slow consumer from bloating the database.
     *
     * The publisher inspects `pg_stat_activity` from a *separate* connection
     * while it runs. If the claim's transaction were still open, this worker's
     * backend would show `idle in transaction` and
     * `pg_stat_activity.xact_start` would be non-null — which is exactly the
     * state that holds back VACUUM's cleanup horizon across the whole database.
     */
    await postWithEvent(1000n, accountA);

    let openTransactions = -1;
    const publish: Publisher = async () => {
      const { rows } = await ctx.pool.query<{ n: bigint }>(
        `SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND xact_start IS NOT NULL
            AND pid <> pg_backend_pid()`,
      );
      openTransactions = Number(rows[0]!.n);
    };

    await drainOnce(worker(publish));

    // Zero other transactions in flight while publishing.
    expect(openTransactions).toBe(0);
  });

  it('a claimed row is in_flight and attributed to its worker', async () => {
    await postWithEvent(1000n, accountA);

    const claimed = await claimBatch(worker(recorder().publish, allShards(), 'worker-7'));
    expect(claimed).toHaveLength(1);

    const { rows } = await ctx.pool.query<{ state: string; claimed_by: string }>(
      'SELECT state, claimed_by FROM outbox',
    );
    expect(rows[0]).toEqual({ state: 'in_flight', claimed_by: 'worker-7' });
  });

  it('two workers on the same shards do not claim the same row', async () => {
    for (let i = 0; i < 6; i += 1) await postWithEvent(100n, accountA);

    const [a, b] = await Promise.all([
      claimBatch(worker(recorder().publish, allShards(), 'wa')),
      claimBatch(worker(recorder().publish, allShards(), 'wb')),
    ]);

    const ids = [...a, ...b].map((e) => e.id.toString());
    // SKIP LOCKED: disjoint sets, and nobody blocked.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('claims nothing that is not yet available', async () => {
    const id = await postWithEvent(1000n, accountA);
    await ctx.pool.query(
      `UPDATE outbox SET available_at = now() + interval '1 hour' WHERE id = $1::bigint`,
      [id.toString()],
    );

    expect(await claimBatch(worker(recorder().publish))).toHaveLength(0);
  });
});

describe('per-account ordering', () => {
  it('a shard is owned by one worker, so one account is never split', () => {
    // Every shard owned by exactly one worker, and no shard orphaned.
    for (const total of [1, 2, 3, 4, 8, 16]) {
      const owned = Array.from({ length: total }, (_, i) => shardsFor(i, total));
      const flat = owned.flat();

      expect(new Set(flat).size).toBe(SHARD_COUNT);
      expect(flat).toHaveLength(SHARD_COUNT);
    }
  });

  it('rejects an impossible shard assignment rather than silently dropping shards', () => {
    expect(() => shardsFor(3, 3)).toThrow(RangeError);
    expect(() => shardsFor(-1, 2)).toThrow(RangeError);
    expect(() => shardsFor(0, 0)).toThrow(RangeError);
  });

  it('the shard column is generated from account_id and cannot drift', async () => {
    await postWithEvent(1000n, accountA);

    const { rows } = await ctx.pool.query<{ account_id: bigint; shard: number }>(
      'SELECT account_id, shard FROM outbox',
    );
    expect(rows[0]?.shard).toBe(Number(rows[0]!.account_id % BigInt(SHARD_COUNT)));

    // GENERATED ALWAYS: no code path can make them disagree.
    await expect(ctx.pool.query('UPDATE outbox SET shard = 99')).rejects.toMatchObject({
      code: '428C9',
    });
  });

  it('publishes one account’s events in id order', async () => {
    const ids: bigint[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await postWithEvent(100n, accountA));

    const rec = recorder();
    await drainOnce(worker(rec.publish));

    expect(rec.seen).toEqual(ids);
  });

  it('publishes sequentially, so two events for one account are never in flight at once', async () => {
    await postWithEvent(100n, accountA);
    await postWithEvent(100n, accountA);

    let concurrent = 0;
    let maxConcurrent = 0;

    const publish: Publisher = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent -= 1;
    };

    await drainOnce(worker(publish));

    /**
     * 1, not 2. `Promise.all` over a batch would make this 2 and would discard
     * the ordering guarantee the sharding exists to provide — the slower of two
     * network calls would land second regardless of event order.
     */
    expect(maxConcurrent).toBe(1);
  });

  it('two workers owning different shards handle different accounts', async () => {
    await postWithEvent(100n, accountA);
    await postWithEvent(100n, accountB);

    const shardA = Number(accountA % BigInt(SHARD_COUNT));
    const shardB = Number(accountB % BigInt(SHARD_COUNT));

    // The fixture's two accounts have consecutive ids, so distinct shards.
    expect(shardA).not.toBe(shardB);

    const recA = recorder();
    await drainOnce(worker(recA.publish, [shardA], 'wa'));

    // Worker A saw only account A's event.
    expect(recA.accounts).toEqual([accountA]);
  });
});

describe('retries, backoff and the dead letter', () => {
  const failing: Publisher = () => Promise.reject(new Error('broker unreachable'));

  it('a failed publish goes back to pending with a future available_at', async () => {
    const id = await postWithEvent(1000n, accountA);

    const result = await drainOnce(worker(failing));
    expect(result).toMatchObject({ claimed: 1, published: 0, retried: 1, dead: 0 });

    const { rows } = await ctx.pool.query<{
      state: string;
      attempts: number;
      last_error: string;
      future: boolean;
    }>(
      `SELECT state, attempts, last_error, available_at > now() AS future
         FROM outbox WHERE id = $1::bigint`,
      [id.toString()],
    );

    expect(rows[0]).toMatchObject({ state: 'pending', attempts: 1 });
    expect(rows[0]?.last_error).toContain('broker unreachable');
    // Backed off, so a failing row does not spin and does not block the shard.
    expect(rows[0]?.future).toBe(true);
  });

  it('dead-letters after max_attempts and never retries it again', async () => {
    const id = await postWithEvent(1000n, accountA);
    await ctx.pool.query('UPDATE outbox SET max_attempts = 3 WHERE id = $1::bigint', [
      id.toString(),
    ]);

    for (let i = 0; i < 3; i += 1) {
      await ctx.pool.query('UPDATE outbox SET available_at = now() WHERE id = $1::bigint', [
        id.toString(),
      ]);
      await drainOnce(worker(failing));
    }

    const { rows } = await ctx.pool.query<{ state: string; attempts: number }>(
      'SELECT state, attempts FROM outbox WHERE id = $1::bigint',
      [id.toString()],
    );
    expect(rows[0]).toEqual({ state: 'dead', attempts: 3 });

    // A poison message retried forever is how a queue stops delivering
    // anything else. Dead rows are never claimed again.
    expect(await claimBatch(worker(recorder().publish))).toHaveLength(0);
  });

  it('the attempts counter is bounded by the database too', async () => {
    const id = await postWithEvent(1000n, accountA);
    await expect(
      ctx.pool.query('UPDATE outbox SET attempts = max_attempts + 1 WHERE id = $1::bigint', [
        id.toString(),
      ]),
    ).rejects.toMatchObject({ constraint: 'outbox_attempts_bounded' });
  });

  it('markFailed reports which outcome it took', async () => {
    const id = await postWithEvent(1000n, accountA);
    const event: OutboxEvent = {
      id,
      transactionId: 0n,
      accountId: accountA,
      eventType: 'x',
      payload: {},
      attempts: 1,
      maxAttempts: 3,
      shard: 0,
    };

    expect(await markFailed(ctx.pool, event, new Error('nope'))).toBe('retry');
    expect(await markFailed(ctx.pool, { ...event, attempts: 3 }, new Error('nope'))).toBe('dead');
  });
});

describe('reclaiming a dead worker’s rows', () => {
  it('a stale in_flight row is reclaimed, because delivery is at-least-once', async () => {
    const id = await postWithEvent(1000n, accountA);
    await claimBatch(worker(recorder().publish));

    // Simulate the worker dying mid-publish.
    await ctx.pool.query(
      `UPDATE outbox SET claimed_at = now() - interval '10 minutes' WHERE id = $1::bigint`,
      [id.toString()],
    );

    expect(await reclaimStale(ctx.pool, 300)).toBe(1);

    const { rows } = await ctx.pool.query<{ state: string }>(
      'SELECT state FROM outbox WHERE id = $1::bigint',
      [id.toString()],
    );
    expect(rows[0]?.state).toBe('pending');

    // Republishing an event the dead worker may already have sent is acceptable
    // precisely because delivery is at-least-once and consumers are idempotent.
    const rec = recorder();
    await drainOnce(worker(rec.publish));
    expect(rec.seen).toEqual([id]);
  });

  it('does not reclaim a row that was only just claimed', async () => {
    await postWithEvent(1000n, accountA);
    await claimBatch(worker(recorder().publish));

    expect(await reclaimStale(ctx.pool, 300)).toBe(0);
  });

  it('a stuck row blocks its own shard, which is why reclaiming matters', async () => {
    // Ordering means the next event for an account cannot overtake a stuck one.
    const first = await postWithEvent(100n, accountA);
    await claimBatch(worker(recorder().publish));
    await postWithEvent(100n, accountA);

    const rec = recorder();
    await drainOnce(worker(rec.publish));

    // The second event is claimable, but the first is still in_flight — so the
    // account's order is only preserved if the first is eventually reclaimed
    // rather than abandoned.
    const { rows } = await ctx.pool.query<{ state: string }>(
      'SELECT state FROM outbox WHERE id = $1::bigint',
      [first.toString()],
    );
    expect(rows[0]?.state).toBe('in_flight');
    expect(await reclaimStale(ctx.pool, 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('the reaper', () => {
  it('deletes old published rows and keeps recent ones', async () => {
    const oldId = await postWithEvent(100n, accountA);
    await drainOnce(worker(recorder().publish));
    await ctx.pool.query(
      `UPDATE outbox SET published_at = now() - interval '48 hours' WHERE id = $1::bigint`,
      [oldId.toString()],
    );

    await postWithEvent(100n, accountA);
    await drainOnce(worker(recorder().publish));

    expect(await reap(ctx.pool, 24)).toBe(1);

    const { rows } = await ctx.pool.query<{ n: bigint }>('SELECT count(*) AS n FROM outbox');
    expect(rows[0]?.n).toBe(1n);
  });

  it('NEVER deletes a dead row, however old', async () => {
    // Deleting an undelivered event to tidy a table is how a system quietly
    // loses data. Dead rows wait for a human.
    const id = await postWithEvent(100n, accountA);
    await ctx.pool.query(
      `UPDATE outbox SET state = 'dead', attempts = 1, created_at = now() - interval '100 days'
        WHERE id = $1::bigint`,
      [id.toString()],
    );

    expect(await reap(ctx.pool, 1)).toBe(0);

    const { rows } = await ctx.pool.query<{ n: bigint }>(
      `SELECT count(*) AS n FROM outbox WHERE state = 'dead'`,
    );
    expect(rows[0]?.n).toBe(1n);
  });
});

describe('lag, the thing to alert on', () => {
  it('reports pending, in_flight, dead and the age of the oldest unpublished', async () => {
    await postWithEvent(100n, accountA);
    await ctx.pool.query(`UPDATE outbox SET created_at = now() - interval '90 seconds'`);

    const l = await lag(ctx.pool);

    expect(l.pending).toBe(1n);
    expect(l.inFlight).toBe(0n);
    expect(l.dead).toBe(0n);
    expect(Number(l.oldestUnpublishedSeconds)).toBeGreaterThanOrEqual(89);
  });

  it('drops to zero once everything is published', async () => {
    await postWithEvent(100n, accountA);
    await drainOnce(worker(recorder().publish));

    const l = await lag(ctx.pool);
    expect(l.pending).toBe(0n);
    expect(l.oldestUnpublishedSeconds).toBe(0n);
  });

  it('counts stale claims separately from ordinary in_flight', async () => {
    await postWithEvent(100n, accountA);
    await claimBatch(worker(recorder().publish));
    await ctx.pool.query(`UPDATE outbox SET claimed_at = now() - interval '10 minutes'`);

    const l = await lag(ctx.pool);
    expect(l.inFlight).toBe(1n);
    expect(l.staleClaims).toBe(1n);
  });
});

describe('the dual-write bug the outbox replaces', () => {
  it('a crash between commit and publish loses the event permanently', async () => {
    const rec = recorder();

    await expect(
      publishAfterCommitNaive({
        pool: ctx.pool,
        publish: rec.publish,
        event: {
          transactionId: 1n,
          accountId: accountA,
          eventType: 'ledger.posted',
          payload: { lost: true },
        },
        // The window. In production this is a SIGKILL, an OOM, a node
        // eviction, or a network partition — low probability per request and
        // certain at volume.
        killBetween: () => Promise.reject(new Error('process killed')),
      }),
    ).rejects.toThrow('process killed');

    // Nothing was published...
    expect(rec.seen).toEqual([]);

    // ...and nothing records that an event is owed. No retry can recover it,
    // because no retry knows to look.
    const { rows } = await ctx.pool.query<{ n: bigint }>('SELECT count(*) AS n FROM outbox');
    expect(rows[0]?.n).toBe(0n);
  });

  it('the outbox path survives the same crash', async () => {
    // The A/B. Same failure, different outcome: the event is durable because it
    // was committed with the ledger write.
    await postWithEvent(100n, accountA);

    const { rows } = await ctx.pool.query<{ n: bigint; state: string }>(
      'SELECT count(*) AS n, min(state) AS state FROM outbox',
    );
    expect(rows[0]).toEqual({ n: 1n, state: 'pending' });

    // A later poll — by any worker, after any crash — picks it up.
    const rec = recorder();
    await drainOnce(worker(rec.publish));
    expect(rec.seen).toHaveLength(1);
  });

  it('at-least-once: a crash AFTER publishing republishes', async () => {
    /**
     * The honest cost of the design, asserted rather than glossed. The worker
     * publishes, then dies before marking the row done; the next poll publishes
     * again. This is why consumers must be idempotent, and why the webhook
     * endpoint in Phase 4 is built the way it is.
     */
    const id = await postWithEvent(100n, accountA);
    const seen: bigint[] = [];

    // First worker: publishes, then "dies" before settling.
    const claimed = await claimBatch(worker(() => Promise.resolve()));
    expect(claimed).toHaveLength(1);
    seen.push(claimed[0]!.id);

    // Its claim goes stale and is reclaimed.
    await ctx.pool.query(`UPDATE outbox SET claimed_at = now() - interval '10 minutes'`);
    await reclaimStale(ctx.pool, 300);

    // Second worker publishes the same event again.
    const rec = recorder();
    await drainOnce(worker(rec.publish));

    expect(rec.seen).toEqual([id]);
    expect(seen).toEqual([id]);
    // Delivered twice. Not a defect — the stated guarantee.
  });
});
