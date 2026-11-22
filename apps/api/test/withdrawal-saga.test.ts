import { beforeEach, describe, expect, it } from 'vitest';
import { parseCash } from '@daftar/money';
import { useTestDatabase } from './support/test-database.ts';
import { resetLedger } from './support/reset.ts';
import { FUNDING_EXTERNAL_ID } from '../src/exchange/cash.ts';
import { GUEST_STARTING_CASH, createGuest, findParticipant } from '../src/exchange/participants.ts';
import {
  paymentStatus,
  setRailChaos,
  submitPayment,
  RailTimeoutError,
} from '../src/exchange/rail.ts';
import {
  approve,
  getWithdrawal,
  holdAccountExternalId,
  markSubmitted,
  release,
  requestWithdrawal,
  requeue,
  settle,
} from '../src/exchange/withdrawals.ts';
import { checkHoldBalances } from '../src/events/consumers/reconciler.ts';

/**
 * The withdrawal saga's money rules, against real PostgreSQL.
 *
 * Rules under test (from the feature spec, not from the code):
 *  - requesting a withdrawal takes the cash out of what can be spent, at once;
 *  - a withdrawal is paid out at most once, however often its steps run;
 *  - a failed withdrawal returns the cash, once;
 *  - only legal state changes are possible, and the database says no to the rest;
 *  - a guest's hold account always equals their unfinished withdrawals.
 */

const ctx = useTestDatabase({ poolMax: 10 });
const THRESHOLD = parseCash('5000.00');

let seq = 0;
const nextId = (p: string) => `${p}:wd-${String((seq += 1)).padStart(6, '0')}`;

async function guest() {
  const created = await createGuest(ctx.pool);
  return (await findParticipant(ctx.pool, created.externalId))!;
}

const balance = async (externalId: string): Promise<bigint> => {
  const { rows } = await ctx.pool.query<{ balance: bigint }>(
    'SELECT balance FROM accounts WHERE external_id = $1',
    [externalId],
  );
  return rows[0]?.balance ?? 0n;
};

const noChaos = {
  timeoutButSucceededPct: 0,
  dropPct: 0,
  rejectPct: 0,
  latencyMs: 0,
  confirmAfterMs: 0,
};

async function requested(amount = '100.00') {
  const g = await guest();
  const result = await requestWithdrawal(ctx.pool, {
    mover: g,
    externalId: nextId(g.externalId),
    amount: parseCash(amount),
    reviewThreshold: THRESHOLD,
  });
  if (result.status !== 'requested') throw new Error(result.status);
  return { g, w: result.withdrawal };
}

beforeEach(async () => {
  await resetLedger(ctx.pool);
  await setRailChaos(ctx.pool, noChaos);
});

describe('requesting a withdrawal', () => {
  it('moves the cash out of what can be spent, into the guest’s hold, in the same commit', async () => {
    const { g, w } = await requested('100.00');
    expect(w.state).toBe('held');
    expect(await balance(g.externalId)).toBe(GUEST_STARTING_CASH - parseCash('100.00'));
    expect(await balance(holdAccountExternalId(g.externalId))).toBe(parseCash('100.00'));
  });

  it('waits for a review at or above the threshold', async () => {
    const { w } = await requested('5000.00');
    expect(w.state).toBe('review');
  });

  it('refuses more than the guest has, and moves nothing', async () => {
    const g = await guest();
    const result = await requestWithdrawal(ctx.pool, {
      mover: g,
      externalId: nextId(g.externalId),
      amount: GUEST_STARTING_CASH + 1n,
      reviewThreshold: THRESHOLD,
    });
    expect(result.status).toBe('insufficient_funds');
    expect(await balance(g.externalId)).toBe(GUEST_STARTING_CASH);
  });
});

describe('a withdrawal is paid out at most once', () => {
  it('settling twice, even concurrently, pays out once', async () => {
    const { g, w } = await requested('100.00');
    await markSubmitted(ctx.pool, w.id);
    const funding0 = await balance(FUNDING_EXTERNAL_ID);

    const outcomes = await Promise.all([
      settle(ctx.pool, w.id),
      settle(ctx.pool, w.id),
      settle(ctx.pool, w.id),
    ]);
    expect(outcomes.filter((o) => o === 'done')).toHaveLength(1);

    expect((await getWithdrawal(ctx.pool, w.id))!.state).toBe('confirmed');
    expect(await balance(FUNDING_EXTERNAL_ID)).toBe(funding0 + parseCash('100.00'));
    expect(await balance(holdAccountExternalId(g.externalId))).toBe(0n);
  });

  it('marking submitted twice counts one attempt', async () => {
    const { w } = await requested();
    const [a, b] = await Promise.all([
      markSubmitted(ctx.pool, w.id),
      markSubmitted(ctx.pool, w.id),
    ]);
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);
    expect((await getWithdrawal(ctx.pool, w.id))!.submitAttempts).toBe(1);
  });

  it('a submission the rail never received is resubmitted under the same reference and paid once', async () => {
    // Worker died after marking it submitted and before calling the rail.
    const { w } = await requested();
    await markSubmitted(ctx.pool, w.id);
    expect(await paymentStatus(ctx.pool, w.railReference)).toBe('not_found');

    await requeue(ctx.pool, w.id, 'rail has no record');
    const again = await markSubmitted(ctx.pool, w.id);
    expect(again).not.toBeNull();
    expect(await submitPayment(ctx.pool, { reference: w.railReference, amount: w.amount })).toBe(
      'accepted',
    );
    // A duplicate submission of the same reference is the same payment.
    expect(await submitPayment(ctx.pool, { reference: w.railReference, amount: w.amount })).toBe(
      'accepted',
    );

    const { rows } = await ctx.pool.query('SELECT 1 FROM sim_rail_payments WHERE reference = $1', [
      w.railReference,
    ]);
    expect(rows).toHaveLength(1);
    expect(await paymentStatus(ctx.pool, w.railReference)).toBe('confirmed');
    expect(await settle(ctx.pool, w.id)).toBe('done');
    expect(await settle(ctx.pool, w.id)).toBe('noop');
  });

  it('a timeout the rail actually processed is found by asking, not paid again', async () => {
    await setRailChaos(ctx.pool, { ...noChaos, timeoutButSucceededPct: 100 });
    const { w } = await requested();
    await markSubmitted(ctx.pool, w.id);
    await expect(
      submitPayment(ctx.pool, { reference: w.railReference, amount: w.amount }),
    ).rejects.toBeInstanceOf(RailTimeoutError);
    expect(await paymentStatus(ctx.pool, w.railReference)).toBe('confirmed');
    expect(await settle(ctx.pool, w.id)).toBe('done');
  });
});

describe('a failed withdrawal returns the cash, once', () => {
  it('a rejection releases the hold back to the guest exactly once', async () => {
    const { g, w } = await requested('250.00');
    await markSubmitted(ctx.pool, w.id);
    const outcomes = await Promise.all([
      release(ctx.pool, w.id, 'rejected by the rail', 'test'),
      release(ctx.pool, w.id, 'rejected by the rail', 'test'),
    ]);
    expect(outcomes.filter((o) => o === 'done')).toHaveLength(1);
    expect(await balance(g.externalId)).toBe(GUEST_STARTING_CASH);
    expect(await balance(holdAccountExternalId(g.externalId))).toBe(0n);

    const { rows } = await ctx.pool.query<{ to_state: string }>(
      'SELECT to_state FROM withdrawal_transitions WHERE withdrawal_id = $1::bigint ORDER BY id',
      [w.id.toString()],
    );
    expect(rows.map((r) => r.to_state)).toEqual([
      'requested',
      'held',
      'submitted',
      'failed',
      'released',
    ]);
  });

  it('a confirmed withdrawal can never be released', async () => {
    const { g, w } = await requested();
    await markSubmitted(ctx.pool, w.id);
    expect(await settle(ctx.pool, w.id)).toBe('done');
    expect(await release(ctx.pool, w.id, 'late failure', 'test')).toBe('noop');
    expect(await balance(g.externalId)).toBe(GUEST_STARTING_CASH - parseCash('100.00'));
  });
});

describe('the database enforces the state machine', () => {
  it('rejects an illegal transition with 23514 (check_violation)', async () => {
    const { w } = await requested();
    await expect(
      ctx.pool.query(`UPDATE withdrawals SET state = 'released' WHERE id = $1::bigint`, [
        w.id.toString(),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects confirmed without a settlement transaction', async () => {
    const { w } = await requested();
    await markSubmitted(ctx.pool, w.id);
    await expect(
      ctx.pool.query(`UPDATE withdrawals SET state = 'confirmed' WHERE id = $1::bigint`, [
        w.id.toString(),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects changing the amount of a withdrawal', async () => {
    const { w } = await requested();
    await expect(
      ctx.pool.query(`UPDATE withdrawals SET amount = 1 WHERE id = $1::bigint`, [w.id.toString()]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('review → approved goes back into the pipeline as held', async () => {
    const { w } = await requested('6000.00');
    expect(await approve(ctx.pool, w.id, 'admin')).not.toBeNull();
    expect((await getWithdrawal(ctx.pool, w.id))!.state).toBe('held');
  });
});

describe('the hold account equals the unfinished withdrawals', () => {
  it('holds after a mix of paid, returned and pending withdrawals', async () => {
    const a = await requested('100.00');
    await markSubmitted(ctx.pool, a.w.id);
    await settle(ctx.pool, a.w.id);

    const b = await requested('200.00');
    await release(ctx.pool, b.w.id, 'test', 'test');

    await requested('300.00');
    await requested('6000.00');

    expect(await checkHoldBalances(ctx.pool)).toBe(0);
  });

  it('reports a hold written around the saga', async () => {
    const { g } = await requested('100.00');
    // A write that bypasses the saga: an extra ledger leg into the hold.
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: tx } = await client.query<{ id: bigint }>(
        `INSERT INTO ledger_transactions (kind) VALUES ('adjustment') RETURNING id`,
      );
      const ids = await client.query<{ hold: bigint; cash: bigint }>(
        `SELECT (SELECT id FROM accounts WHERE external_id = $1) AS hold,
                (SELECT id FROM accounts WHERE external_id = $2) AS cash`,
        [holdAccountExternalId(g.externalId), g.externalId],
      );
      const { hold, cash } = ids.rows[0]!;
      await client.query(
        `INSERT INTO entries (transaction_id, account_id, amount, direction, unit) VALUES
           ($1::bigint, $2::bigint, 1, 'credit', 'USD'), ($1::bigint, $3::bigint, -1, 'debit', 'USD')`,
        [tx[0]!.id.toString(), hold.toString(), cash.toString()],
      );
      await client.query('UPDATE accounts SET balance = balance + 1 WHERE id = $1::bigint', [
        hold.toString(),
      ]);
      await client.query('UPDATE accounts SET balance = balance - 1 WHERE id = $1::bigint', [
        cash.toString(),
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await checkHoldBalances(ctx.pool)).toBe(1);
  });
});
