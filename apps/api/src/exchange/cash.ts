import type pg from 'pg';
import { post, type PostAttemptStats } from '../ledger/post.ts';
import { enqueue } from '../outbox/worker.ts';
import { DEFAULT_MARKET, reservationsOf } from './engine.ts';

/**
 * # Cash that moves outside the order book
 *
 * Withdrawals and transfers between guests. Unlike a fill, neither takes the
 * market lock — and that is the point of this file rather than an omission.
 *
 * ## The first exchange path where the account locks do real work
 *
 * Everything the matcher does is serialised by one row lock per market, so the
 * per-account locks inside `postWithin()` are taken there but never contended.
 * A withdrawal arrives on its own connection, at any moment, against a cash
 * account a fill may be debiting right now. What keeps the two from both
 * spending the same money is `post()`: the advisory lock on the account, the
 * balance read under it, and the non-negative check.
 *
 * A transfer A→B racing a transfer B→A is the textbook deadlock, and it cannot
 * happen here for the reason `lockOrder()` gives: both sort the two account ids
 * and acquire low-first.
 *
 * ## Reserved cash, and why the check on it is only a courtesy
 *
 * A guest's open buy orders reserve cash by arithmetic, not by moving it (see
 * `engine.ts`). This file refuses to move cash that is reserved — but it reads
 * the reservations without the market lock, so an order placed in the same
 * instant can slip past. That is safe, and by design: the ledger never lets the
 * balance go negative, and a resting order that can no longer be covered is
 * withdrawn by the matcher at fill time (`cancel_reason = insufficient_funds`).
 * The worst case is a cancelled order, never an overdraft.
 */

/**
 * The boundary account real-looking money crosses: deposits come from it,
 * withdrawals go to it. Its balance is minus the net cash that has entered.
 *
 * The legacy webhook handler already debits this account by name; the exchange
 * database simply never had one, because nothing there had been funded by a
 * provider.
 */
export const FUNDING_EXTERNAL_ID = 'external:funding';

/** Ceiling on one withdrawal or transfer: 1,000,000.00. A bound for its own sake. */
export const MAX_CASH_MOVEMENT = 100_000_000n;

export async function ensureFundingAccount(pool: pg.Pool): Promise<bigint> {
  await pool.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol)
     VALUES ($1, 'external_funding', NULL)
     ON CONFLICT (external_id) DO NOTHING`,
    [FUNDING_EXTERNAL_ID],
  );

  const { rows } = await pool.query<{ id: bigint }>(
    'SELECT id FROM accounts WHERE external_id = $1',
    [FUNDING_EXTERNAL_ID],
  );
  return rows[0]!.id;
}

interface Mover {
  id: bigint;
  externalId: string;
  cashAccountId: bigint;
}

export type CashMovementResult =
  | ({ status: 'moved'; transactionId: bigint; balanceAfter: bigint } & PostAttemptStats)
  | { status: 'insufficient_funds'; available: bigint; required: bigint }
  | { status: 'unknown_recipient' }
  | { status: 'self_transfer' };

/**
 * What the guest could move right now: balance less what open buy orders have
 * reserved. Read without the market lock — see the note at the top.
 */
async function availableCash(pool: pg.Pool, mover: Mover): Promise<bigint> {
  const { rows } = await pool.query<{ balance: bigint }>(
    'SELECT balance FROM accounts WHERE id = $1::bigint',
    [mover.cashAccountId.toString()],
  );
  const reserved = await reservationsOf(pool, mover.id, DEFAULT_MARKET);
  return (rows[0]?.balance ?? 0n) - reserved.cash;
}

/**
 * Send cash out of the system: guest debited, `external:funding` credited.
 *
 * The `cash_movements` row and the outbox event are written inside the ledger
 * transaction, so all three exist or none do. `externalId` is UNIQUE; a repeat
 * surfaces as 23505 (unique_violation) for the route to turn into a 409.
 */
export async function withdraw(
  pool: pg.Pool,
  request: { mover: Mover; externalId: string; amount: bigint },
): Promise<CashMovementResult> {
  const { mover, amount } = request;
  if (amount <= 0n) throw new RangeError('withdrawal amount must be positive');

  const available = await availableCash(pool, mover);
  if (available < amount) {
    return {
      status: 'insufficient_funds',
      available: available < 0n ? 0n : available,
      required: amount,
    };
  }

  const funding = await ensureFundingAccount(pool);

  const result = await post(pool, {
    kind: 'payout',
    legs: [
      { accountId: mover.cashAccountId, amount: -amount },
      { accountId: funding, amount },
    ],
    requireNonNegative: [mover.cashAccountId],
    // Pinned, like the matcher's: the two share accounts and should share a
    // locking discipline.
    mode: 'advisory',
    withinTransaction: async (client, transactionId) => {
      await client.query(
        `INSERT INTO cash_movements (external_id, kind, participant_id, amount, transaction_id)
         VALUES ($1, 'withdrawal', $2::bigint, $3::bigint, $4::bigint)`,
        [request.externalId, mover.id.toString(), amount.toString(), transactionId.toString()],
      );

      await enqueue(client, {
        transactionId,
        accountId: mover.cashAccountId,
        eventType: 'withdrawal.completed',
        payload: { amount: amount.toString() },
      });
    },
  });

  if (result.status === 'insufficient_funds') {
    // The ledger's answer, under the account lock. A fill or another withdrawal
    // landed between the courtesy check above and here.
    return { status: 'insufficient_funds', available: result.available, required: amount };
  }
  if (result.status === 'no_such_account') {
    throw new Error(`withdrawal references a missing account ${String(result.accountId)}`);
  }

  return {
    status: 'moved',
    transactionId: result.transactionId,
    balanceAfter: result.balances.get(mover.cashAccountId) ?? 0n,
    attempts: result.attempts,
    serializationFailures: result.serializationFailures,
    deadlocks: result.deadlocks,
  };
}

/**
 * Move cash from one guest to another, addressed by the recipient's handle.
 *
 * Two outbox events, one per side, each keyed on its own cash account — an
 * outbox row belongs to one account's shard, and both guests' feeds need to
 * hear about it in order relative to their own other events.
 */
export async function transfer(
  pool: pg.Pool,
  request: {
    mover: Mover & { handle: string; displayName: string };
    externalId: string;
    toHandle: string;
    amount: bigint;
  },
): Promise<CashMovementResult> {
  const { mover, amount } = request;
  if (amount <= 0n) throw new RangeError('transfer amount must be positive');

  const { rows } = await pool.query<{
    id: bigint;
    cash_account_id: bigint;
    handle: string;
    display_name: string;
  }>(
    // Guests only. A bot's cash is unlimited in one direction and meaningless
    // in the other; paying one is giving money to nobody.
    `SELECT id, cash_account_id, handle, display_name
       FROM participants WHERE handle = $1 AND kind = 'guest'`,
    [request.toHandle],
  );

  const recipient = rows[0];
  if (!recipient) return { status: 'unknown_recipient' };
  if (recipient.id === mover.id) return { status: 'self_transfer' };

  const available = await availableCash(pool, mover);
  if (available < amount) {
    return {
      status: 'insufficient_funds',
      available: available < 0n ? 0n : available,
      required: amount,
    };
  }

  const result = await post(pool, {
    kind: 'adjustment',
    legs: [
      { accountId: mover.cashAccountId, amount: -amount },
      { accountId: recipient.cash_account_id, amount },
    ],
    requireNonNegative: [mover.cashAccountId],
    mode: 'advisory',
    withinTransaction: async (client, transactionId) => {
      await client.query(
        `INSERT INTO cash_movements
           (external_id, kind, participant_id, counterparty_id, amount, transaction_id)
         VALUES ($1, 'transfer', $2::bigint, $3::bigint, $4::bigint, $5::bigint)`,
        [
          request.externalId,
          mover.id.toString(),
          recipient.id.toString(),
          amount.toString(),
          transactionId.toString(),
        ],
      );

      await enqueue(client, {
        transactionId,
        accountId: mover.cashAccountId,
        eventType: 'transfer.sent',
        payload: {
          amount: amount.toString(),
          counterparty: recipient.display_name,
          counterpartyHandle: recipient.handle,
        },
      });

      await enqueue(client, {
        transactionId,
        accountId: recipient.cash_account_id,
        eventType: 'transfer.received',
        payload: {
          amount: amount.toString(),
          counterparty: mover.displayName,
          counterpartyHandle: mover.handle,
        },
      });
    },
  });

  if (result.status === 'insufficient_funds') {
    return { status: 'insufficient_funds', available: result.available, required: amount };
  }
  if (result.status === 'no_such_account') {
    throw new Error(`transfer references a missing account ${String(result.accountId)}`);
  }

  return {
    status: 'moved',
    transactionId: result.transactionId,
    balanceAfter: result.balances.get(mover.cashAccountId) ?? 0n,
    attempts: result.attempts,
    serializationFailures: result.serializationFailures,
    deadlocks: result.deadlocks,
  };
}

/**
 * Net cash a guest has put in: the opening credit, plus deposits and transfers
 * received, less withdrawals and transfers sent.
 *
 * Read from the ledger rather than summed from `deposits` and
 * `cash_movements`: those tables say what was asked for, the entries say what
 * happened. Every non-trade movement on a cash account is one of these three
 * transaction kinds, and every trade is `buy` or `sell`.
 *
 * Profit and loss is equity minus this figure. Measured against the fixed
 * opening balance instead, a deposit would read as profit.
 */
export async function netContributed(pool: pg.Pool, cashAccountId: bigint): Promise<bigint> {
  const { rows } = await pool.query<{ net: bigint }>(
    `SELECT coalesce(sum(e.amount), 0)::bigint AS net
       FROM entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE e.account_id = $1::bigint
        AND t.kind IN ('funding', 'payout', 'adjustment')`,
    [cashAccountId.toString()],
  );
  return rows[0]!.net;
}

export interface ActivityItem {
  id: bigint;
  eventType: string;
  payload: unknown;
  occurredAt: string;
  publishedAt: string;
}

/** A participant's activity feed, newest first. Written only by the outbox worker. */
export async function listActivity(
  pool: pg.Pool,
  participantId: bigint,
  limit: number,
): Promise<ActivityItem[]> {
  const { rows } = await pool.query<{
    id: bigint;
    event_type: string;
    payload: unknown;
    occurred_at: string;
    published_at: string;
  }>(
    `SELECT id, event_type, payload, occurred_at, published_at
       FROM exchange_activity
      WHERE participant_id = $1::bigint
      ORDER BY id DESC
      LIMIT $2::int`,
    [participantId.toString(), limit],
  );

  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    payload: r.payload,
    occurredAt: r.occurred_at,
    publishedAt: r.published_at,
  }));
}

/**
 * Events owed to this participant that the worker has not delivered yet.
 *
 * This is what makes a stopped worker visible on screen: the money has moved,
 * the balance shows it, and this number says the feed is behind by that many.
 */
export async function pendingActivity(pool: pg.Pool, cashAccountId: bigint): Promise<number> {
  const { rows } = await pool.query<{ pending: number }>(
    `SELECT count(*)::int AS pending
       FROM outbox
      WHERE account_id = $1::bigint AND state IN ('pending', 'in_flight')`,
    [cashAccountId.toString()],
  );
  return rows[0]!.pending;
}
