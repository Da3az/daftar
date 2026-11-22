import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { post, type PostAttemptStats } from '../ledger/post.ts';
import { enqueue } from '../outbox/worker.ts';
import { DEFAULT_MARKET, reservationsOf } from './engine.ts';
import { ensureFundingAccount, recordMovement, type Mover } from './cash.ts';

/**
 * # Withdrawals as a saga
 *
 * A withdrawal used to be one ledger transaction: guest debited, outside world
 * credited, done. A real payout is not like that — the bank answers later, or
 * not at all, or says no — so a withdrawal is now a sequence of states, and
 * the money sits in a **hold account** in between:
 *
 *   request   guest cash  → hold                 (kind `hold`)
 *   confirmed hold        → external:funding     (kind `payout`)
 *   released  hold        → guest cash           (kind `release`)
 *
 * The rules that make it safe, each enforced by the database:
 *
 * - **The money leaves the spendable balance at the request.** The hold
 *   transaction and the `withdrawals` row commit together, under the
 *   ledger's account lock and non-negative check. There is no state in which
 *   a withdrawal exists and its cash could still be spent on an order.
 * - **Every transition is legal and recorded.** A trigger rejects an illegal
 *   state change and writes `withdrawal_transitions` itself, so history cannot
 *   be skipped by a code path that forgets to log.
 * - **At most one settlement or release, ever.** `settle_tx_id` and
 *   `release_tx_id` are each UNIQUE and mutually exclusive, and every step
 *   below is a compare-and-set on the current state. A job that runs twice —
 *   which BullMQ, Kafka redelivery and the sweeper can all cause — finds the
 *   state already moved and does nothing.
 *
 * Kafka carries the state events (through the outbox, like every other
 * event); BullMQ runs the rail calls. Neither is trusted for correctness: the
 * sweeper in `jobs/rail.ts` re-drives anything Postgres says is stuck.
 */

export type WithdrawalState =
  'requested' | 'held' | 'review' | 'submitted' | 'confirmed' | 'failed' | 'released';

export const holdAccountExternalId = (participantExternalId: string): string =>
  `${participantExternalId}:cash_hold`;

export async function ensureHoldAccount(
  pool: pg.Pool,
  participantExternalId: string,
): Promise<bigint> {
  const externalId = holdAccountExternalId(participantExternalId);
  await pool.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol)
     VALUES ($1, 'customer_hold', NULL)
     ON CONFLICT (external_id) DO NOTHING`,
    [externalId],
  );
  const { rows } = await pool.query<{ id: bigint }>(
    'SELECT id FROM accounts WHERE external_id = $1',
    [externalId],
  );
  return rows[0]!.id;
}

/** Transaction-local: read by the transition trigger for the history row. */
async function setTransitionContext(
  client: pg.PoolClient,
  reason: string,
  actor: string,
): Promise<void> {
  await client.query(
    `SELECT set_config('daftar.transition_reason', $1, true), set_config('daftar.actor', $2, true)`,
    [reason, actor],
  );
}

export interface Withdrawal {
  id: bigint;
  externalId: string;
  participantId: bigint;
  cashAccountId: bigint;
  holdAccountId: bigint;
  amount: bigint;
  state: WithdrawalState;
  railReference: string;
  submitAttempts: number;
  holdTxId: bigint;
  settleTxId: bigint | null;
  releaseTxId: bigint | null;
  lastRailStatus: string | null;
  reviewReason: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
}

const COLUMNS = `w.id, w.external_id, w.participant_id, p.cash_account_id, w.hold_account_id,
  w.amount, w.state, w.rail_reference, w.submit_attempts, w.hold_tx_id, w.settle_tx_id,
  w.release_tx_id, w.last_rail_status, w.review_reason, w.created_at, w.updated_at, w.submitted_at`;

interface Row {
  id: bigint;
  external_id: string;
  participant_id: bigint;
  cash_account_id: bigint;
  hold_account_id: bigint;
  amount: bigint;
  state: WithdrawalState;
  rail_reference: string;
  submit_attempts: number;
  hold_tx_id: bigint;
  settle_tx_id: bigint | null;
  release_tx_id: bigint | null;
  last_rail_status: string | null;
  review_reason: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
}

const toWithdrawal = (r: Row): Withdrawal => ({
  id: r.id,
  externalId: r.external_id,
  participantId: r.participant_id,
  cashAccountId: r.cash_account_id,
  holdAccountId: r.hold_account_id,
  amount: r.amount,
  state: r.state,
  railReference: r.rail_reference,
  submitAttempts: r.submit_attempts,
  holdTxId: r.hold_tx_id,
  settleTxId: r.settle_tx_id,
  releaseTxId: r.release_tx_id,
  lastRailStatus: r.last_rail_status,
  reviewReason: r.review_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  submittedAt: r.submitted_at,
});

export async function getWithdrawal(
  client: pg.Pool | pg.PoolClient,
  id: bigint,
  forUpdate = false,
): Promise<Withdrawal | null> {
  const { rows } = await client.query<Row>(
    `SELECT ${COLUMNS} FROM withdrawals w JOIN participants p ON p.id = w.participant_id
      WHERE w.id = $1::bigint ${forUpdate ? 'FOR UPDATE OF w' : ''}`,
    [id.toString()],
  );
  return rows[0] ? toWithdrawal(rows[0]) : null;
}

export async function findWithdrawalByExternalId(
  pool: pg.Pool,
  participantId: bigint,
  externalId: string,
): Promise<Withdrawal | null> {
  const { rows } = await pool.query<Row>(
    `SELECT ${COLUMNS} FROM withdrawals w JOIN participants p ON p.id = w.participant_id
      WHERE w.external_id = $1 AND w.participant_id = $2::bigint`,
    [externalId, participantId.toString()],
  );
  return rows[0] ? toWithdrawal(rows[0]) : null;
}

const eventPayload = (
  w: Pick<Withdrawal, 'id' | 'amount'>,
  state: WithdrawalState,
  extra = {},
) => ({
  withdrawalId: w.id.toString(),
  amount: w.amount.toString(),
  state,
  ...extra,
});

/* ------------------------------------------------------------- the request */

export type RequestWithdrawalResult =
  | ({
      status: 'requested';
      withdrawal: Withdrawal;
      balanceAfter: bigint;
      occurredAt: string;
    } & PostAttemptStats)
  | { status: 'insufficient_funds'; available: bigint; required: bigint };

/**
 * Move the cash into the hold account and open the withdrawal, in one
 * transaction. Over `reviewThreshold` it opens in `review` and waits for a
 * human; otherwise `held`, and the dispatcher picks it up from the event.
 *
 * `externalId` is UNIQUE on both `withdrawals` and `cash_movements`; a repeat
 * surfaces as 23505 (unique_violation) for the route to answer as a replay.
 */
export async function requestWithdrawal(
  pool: pg.Pool,
  request: { mover: Mover; externalId: string; amount: bigint; reviewThreshold: bigint },
): Promise<RequestWithdrawalResult> {
  const { mover, amount } = request;
  if (amount <= 0n) throw new RangeError('withdrawal amount must be positive');

  // The courtesy check against reservations, as before (see cash.ts): the
  // ledger's non-negative check under the account lock is the real one.
  const { rows: bal } = await pool.query<{ balance: bigint }>(
    'SELECT balance FROM accounts WHERE id = $1::bigint',
    [mover.cashAccountId.toString()],
  );
  const reserved = await reservationsOf(pool, mover.id, DEFAULT_MARKET);
  const available = (bal[0]?.balance ?? 0n) - reserved.cash;
  if (available < amount) {
    return {
      status: 'insufficient_funds',
      available: available < 0n ? 0n : available,
      required: amount,
    };
  }

  const holdAccountId = await ensureHoldAccount(pool, mover.externalId);
  const state: WithdrawalState = amount >= request.reviewThreshold ? 'review' : 'held';

  let withdrawalId = 0n;
  let occurredAt = '';

  const result = await post(pool, {
    kind: 'hold',
    legs: [
      { accountId: mover.cashAccountId, amount: -amount },
      { accountId: holdAccountId, amount },
    ],
    requireNonNegative: [mover.cashAccountId],
    mode: 'advisory',
    withinTransaction: async (client, transactionId) => {
      await setTransitionContext(
        client,
        state === 'review' ? 'at or over the review threshold' : 'cash moved to hold',
        'guest',
      );
      const { rows } = await client.query<{ id: bigint }>(
        `INSERT INTO withdrawals
           (external_id, participant_id, amount, state, hold_account_id, hold_tx_id, rail_reference,
            review_reason)
         VALUES ($1, $2::bigint, $3::bigint, $4::withdrawal_state, $5::bigint, $6::bigint, $7, $8)
         RETURNING id`,
        [
          request.externalId,
          mover.id.toString(),
          amount.toString(),
          state,
          holdAccountId.toString(),
          transactionId.toString(),
          `wd-${randomUUID()}`,
          state === 'review' ? 'threshold' : null,
        ],
      );
      withdrawalId = rows[0]!.id;

      // The movement row keeps the existing receipt and replay paths working:
      // it is the guest's record that they asked to withdraw this much.
      occurredAt = await recordMovement(client, {
        externalId: request.externalId,
        kind: 'withdrawal',
        participantId: mover.id,
        counterpartyId: null,
        amount,
        transactionId,
        cashAccountId: mover.cashAccountId,
      });

      await enqueue(client, {
        transactionId,
        accountId: mover.cashAccountId,
        eventType: state === 'review' ? 'withdrawal.review' : 'withdrawal.held',
        payload: eventPayload({ id: withdrawalId, amount }, state),
      });
    },
  });

  if (result.status === 'insufficient_funds') {
    return { status: 'insufficient_funds', available: result.available, required: amount };
  }
  if (result.status === 'no_such_account') {
    throw new Error(`withdrawal references a missing account ${String(result.accountId)}`);
  }

  const withdrawal = await getWithdrawal(pool, withdrawalId);
  return {
    status: 'requested',
    withdrawal: withdrawal!,
    balanceAfter: result.balances.get(mover.cashAccountId) ?? 0n,
    occurredAt,
    attempts: result.attempts,
    serializationFailures: result.serializationFailures,
    deadlocks: result.deadlocks,
  };
}

/* --------------------------------------------- transitions with no money */

/** Thrown inside a transaction to abandon a step whose precondition no longer holds. */
class NotApplicable extends Error {
  override name = 'NotApplicable';
}

/**
 * A compare-and-set state change plus its outbox event, in one transaction.
 * Returns the updated withdrawal, or `null` if it was not in one of `from` —
 * already moved on by another run of the same step, which is the expected
 * shape of at-least-once delivery, not an error.
 */
async function transition(
  pool: pg.Pool,
  id: bigint,
  change: {
    from: WithdrawalState[];
    to: WithdrawalState;
    reason: string;
    actor: string;
    eventType: string;
    set?: string;
    extra?: Record<string, unknown>;
  },
): Promise<Withdrawal | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await getWithdrawal(client, id, true);
    if (!current || !change.from.includes(current.state)) {
      await client.query('ROLLBACK');
      return null;
    }
    await setTransitionContext(client, change.reason, change.actor);
    await client.query(
      `UPDATE withdrawals SET state = $2::withdrawal_state ${change.set ? `, ${change.set}` : ''}
        WHERE id = $1::bigint`,
      [id.toString(), change.to],
    );
    await enqueue(client, {
      transactionId: current.holdTxId,
      accountId: current.cashAccountId,
      eventType: change.eventType,
      payload: eventPayload(current, change.to, { reason: change.reason, ...change.extra }),
    });
    await client.query('COMMIT');
    return { ...current, state: change.to };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** held → submitted, counting the attempt. Done *before* the rail call. */
export const markSubmitted = (pool: pg.Pool, id: bigint) =>
  transition(pool, id, {
    from: ['held'],
    to: 'submitted',
    reason: 'sent to the payout rail',
    actor: 'rail.submit',
    eventType: 'withdrawal.submitted',
    set: 'submit_attempts = submit_attempts + 1, submitted_at = now()',
  });

/** submitted → held: the rail has no record of it, so it goes round again. */
export const requeue = (pool: pg.Pool, id: bigint, reason: string) =>
  transition(pool, id, {
    from: ['submitted'],
    to: 'held',
    reason,
    actor: 'rail.poll',
    eventType: 'withdrawal.requeued',
  });

/** → review: a human decides. */
export const toReview = (pool: pg.Pool, id: bigint, reason: string, actor: string) =>
  transition(pool, id, {
    from: ['held', 'submitted'],
    to: 'review',
    reason,
    actor,
    eventType: 'withdrawal.review',
    set: `review_reason = ${pgLiteral(reason)}`,
  });

/** review → held: approved by an operator, back into the pipeline. */
export const approve = (pool: pg.Pool, id: bigint, actor: string) =>
  transition(pool, id, {
    from: ['review'],
    to: 'held',
    reason: 'approved on review',
    actor,
    eventType: 'withdrawal.approved',
  });

/** Records what the rail last said, outside any state change. */
export async function noteRailStatus(pool: pg.Pool, id: bigint, status: string): Promise<void> {
  await pool.query('UPDATE withdrawals SET last_rail_status = $2 WHERE id = $1::bigint', [
    id.toString(),
    status,
  ]);
}

/** A constant from this file only — never user input. */
function pgLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/* --------------------------------------------- the two ways money moves on */

async function finishedElsewhere(pool: pg.Pool, id: bigint): Promise<boolean> {
  const now = await getWithdrawal(pool, id);
  return now !== null && (now.state === 'confirmed' || now.state === 'released');
}

export type FinishOutcome = 'done' | 'noop';

/**
 * submitted → confirmed: the rail paid out. hold → `external:funding`.
 *
 * The compare-and-set runs inside the ledger transaction, so the payout
 * entries and the state change are one commit: a second run finds the state
 * already `confirmed`, throws `NotApplicable`, and its entries roll back.
 */
export async function settle(pool: pg.Pool, id: bigint): Promise<FinishOutcome> {
  const w = await getWithdrawal(pool, id);
  if (!w || w.state !== 'submitted') return 'noop';
  const funding = await ensureFundingAccount(pool);

  try {
    const result = await post(pool, {
      kind: 'payout',
      legs: [
        { accountId: w.holdAccountId, amount: -w.amount },
        { accountId: funding, amount: w.amount },
      ],
      requireNonNegative: [w.holdAccountId],
      mode: 'advisory',
      withinTransaction: async (client, transactionId) => {
        const current = await getWithdrawal(client, id, true);
        if (!current || current.state !== 'submitted') throw new NotApplicable();
        await setTransitionContext(client, 'rail confirmed the payout', 'rail.poll');
        await client.query(
          `UPDATE withdrawals
              SET state = 'confirmed', settle_tx_id = $2::bigint, decided_at = now(),
                  last_rail_status = 'confirmed'
            WHERE id = $1::bigint`,
          [id.toString(), transactionId.toString()],
        );
        await enqueue(client, {
          transactionId,
          accountId: w.cashAccountId,
          eventType: 'withdrawal.confirmed',
          payload: eventPayload(w, 'confirmed'),
        });
      },
    });
    if (result.status !== 'posted') {
      // Two runs racing: the ledger's balance check (under the account lock)
      // runs before the compare-and-set inside the transaction, so the loser
      // sees an empty hold rather than a confirmed state. Found by the
      // concurrent-settle test. If another run finished it, this is a no-op.
      if (await finishedElsewhere(pool, id)) return 'noop';
      // Otherwise the hold is short of its own withdrawal, which only a write
      // around this file can cause — and the reconciler's hold check reports.
      throw new Error(`settlement refused by the ledger: ${result.status}`);
    }
    return 'done';
  } catch (err) {
    if (err instanceof NotApplicable) return 'noop';
    throw err;
  }
}

/**
 * → failed → released: the payout did not happen. hold → guest cash.
 *
 * Two state changes in one transaction, so the history shows why it failed
 * and that the money came back, and nothing can observe it failed-but-held
 * unless the release itself fails (the sweeper retries that).
 */
export async function release(
  pool: pg.Pool,
  id: bigint,
  reason: string,
  actor: string,
): Promise<FinishOutcome> {
  const w = await getWithdrawal(pool, id);
  if (!w || !['held', 'review', 'submitted', 'failed'].includes(w.state)) return 'noop';

  try {
    const result = await post(pool, {
      kind: 'release',
      legs: [
        { accountId: w.holdAccountId, amount: -w.amount },
        { accountId: w.cashAccountId, amount: w.amount },
      ],
      requireNonNegative: [w.holdAccountId],
      mode: 'advisory',
      withinTransaction: async (client, transactionId) => {
        const current = await getWithdrawal(client, id, true);
        if (!current || !['held', 'review', 'submitted', 'failed'].includes(current.state)) {
          throw new NotApplicable();
        }
        await setTransitionContext(client, reason, actor);
        if (current.state !== 'failed') {
          await client.query(
            `UPDATE withdrawals SET state = 'failed', decided_at = now() WHERE id = $1::bigint`,
            [id.toString()],
          );
        }
        await setTransitionContext(client, 'cash returned from hold', actor);
        await client.query(
          `UPDATE withdrawals SET state = 'released', release_tx_id = $2::bigint WHERE id = $1::bigint`,
          [id.toString(), transactionId.toString()],
        );
        await enqueue(client, {
          transactionId,
          accountId: w.cashAccountId,
          eventType: 'withdrawal.released',
          payload: eventPayload(w, 'released', { reason }),
        });
      },
    });
    if (result.status !== 'posted') {
      // The same race as in `settle`.
      if (await finishedElsewhere(pool, id)) return 'noop';
      throw new Error(`release refused by the ledger: ${result.status}`);
    }
    return 'done';
  } catch (err) {
    if (err instanceof NotApplicable) return 'noop';
    throw err;
  }
}

/* ----------------------------------------------------------------- reads */

export interface Transition {
  from: WithdrawalState | null;
  to: WithdrawalState;
  reason: string | null;
  actor: string | null;
  at: string;
}

export async function transitionsOf(
  pool: pg.Pool,
  ids: bigint[],
): Promise<Map<bigint, Transition[]>> {
  const out = new Map<bigint, Transition[]>();
  if (ids.length === 0) return out;
  const { rows } = await pool.query<{
    withdrawal_id: bigint;
    from_state: WithdrawalState | null;
    to_state: WithdrawalState;
    reason: string | null;
    actor: string | null;
    at: string;
  }>(
    `SELECT withdrawal_id, from_state, to_state, reason, actor, at
       FROM withdrawal_transitions WHERE withdrawal_id = ANY($1::bigint[])
      ORDER BY withdrawal_id, id`,
    [ids.map(String)],
  );
  for (const r of rows) {
    const list = out.get(r.withdrawal_id) ?? [];
    list.push({ from: r.from_state, to: r.to_state, reason: r.reason, actor: r.actor, at: r.at });
    out.set(r.withdrawal_id, list);
  }
  return out;
}

export async function listWithdrawals(
  pool: pg.Pool,
  participantId: bigint,
  limit: number,
): Promise<Withdrawal[]> {
  const { rows } = await pool.query<Row>(
    `SELECT ${COLUMNS} FROM withdrawals w JOIN participants p ON p.id = w.participant_id
      WHERE w.participant_id = $1::bigint
      ORDER BY w.id DESC LIMIT $2::int`,
    [participantId.toString(), limit],
  );
  return rows.map(toWithdrawal);
}

export async function listForReview(pool: pg.Pool, limit: number): Promise<Withdrawal[]> {
  const { rows } = await pool.query<Row>(
    `SELECT ${COLUMNS} FROM withdrawals w JOIN participants p ON p.id = w.participant_id
      WHERE w.state NOT IN ('confirmed', 'released')
      ORDER BY (w.state = 'review') DESC, w.updated_at
      LIMIT $1::int`,
    [limit],
  );
  return rows.map(toWithdrawal);
}

/**
 * The split of a guest's withdrawal money: **on hold** is waiting for us
 * (held, in review, or failed and not yet released); **pending** is waiting
 * for the rail (submitted). Both are still the guest's until confirmed.
 */
export async function holdSplit(
  pool: pg.Pool,
  participantId: bigint,
): Promise<{ onHold: bigint; pending: bigint }> {
  const { rows } = await pool.query<{ on_hold: bigint; pending: bigint }>(
    `SELECT coalesce(sum(amount) FILTER (WHERE state IN ('held', 'review', 'failed')), 0)::bigint AS on_hold,
            coalesce(sum(amount) FILTER (WHERE state = 'submitted'), 0)::bigint AS pending
       FROM withdrawals WHERE participant_id = $1::bigint`,
    [participantId.toString()],
  );
  return { onHold: rows[0]?.on_hold ?? 0n, pending: rows[0]?.pending ?? 0n };
}
