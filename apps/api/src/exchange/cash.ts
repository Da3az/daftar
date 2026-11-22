import type pg from 'pg';
import { post, type PostAttemptStats } from '../ledger/post.ts';
import { enqueue } from '../outbox/worker.ts';
import { DEFAULT_MARKET, reservationsOf } from './engine.ts';
import { GUEST_FAUCET_EXTERNAL_ID } from './participants.ts';

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

export interface Mover {
  id: bigint;
  externalId: string;
  cashAccountId: bigint;
}

export type CashMovementResult =
  | ({
      status: 'moved';
      transactionId: bigint;
      balanceAfter: bigint;
      /** The movement row's `created_at`: the database's clock, as the feed's is. */
      occurredAt: string;
    } & PostAttemptStats)
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
 * Write the `cash_movements` row, inside the ledger transaction.
 *
 * `balance_after` is read from `accounts` here, after `post()` has updated it in
 * this same transaction, so a replay can answer with the figure the original
 * request got. Returns the row's `created_at`.
 */
export async function recordMovement(
  client: pg.PoolClient,
  row: {
    externalId: string;
    kind: 'withdrawal' | 'transfer';
    participantId: bigint;
    counterpartyId: bigint | null;
    amount: bigint;
    transactionId: bigint;
    cashAccountId: bigint;
  },
): Promise<string> {
  const { rows } = await client.query<{ created_at: string }>(
    `INSERT INTO cash_movements
       (external_id, kind, participant_id, counterparty_id, amount, transaction_id, balance_after)
     VALUES ($1, $2::cash_movement_kind, $3::bigint, $4::bigint, $5::bigint, $6::bigint,
             (SELECT balance FROM accounts WHERE id = $7::bigint))
     RETURNING created_at`,
    [
      row.externalId,
      row.kind,
      row.participantId.toString(),
      row.counterpartyId === null ? null : row.counterpartyId.toString(),
      row.amount.toString(),
      row.transactionId.toString(),
      row.cashAccountId.toString(),
    ],
  );
  return rows[0]!.created_at;
}

export interface StoredMovement {
  kind: 'withdrawal' | 'transfer';
  amount: bigint;
  /** The recipient's handle, for a transfer. */
  counterpartyHandle: string | null;
  /** NULL for movements made before the column existed. */
  balanceAfter: bigint | null;
  createdAt: string;
}

/**
 * A movement this participant already made under `externalId`, or `null`.
 *
 * Looked up **before** any check, so a retry of a movement that succeeded is
 * answered with that success. Checked first against today's balance instead, a
 * guest who sent their whole balance and lost the connection would be told on
 * the retry that they cannot afford what they already did.
 *
 * Scoped by `participant_id` as well as the (already participant-prefixed)
 * external id, so this can never return another participant's row.
 */
export async function findMovement(
  pool: pg.Pool,
  participantId: bigint,
  externalId: string,
): Promise<StoredMovement | null> {
  const { rows } = await pool.query<{
    kind: 'withdrawal' | 'transfer';
    amount: bigint;
    counterparty_handle: string | null;
    balance_after: bigint | null;
    created_at: string;
  }>(
    `SELECT m.kind, m.amount, c.handle AS counterparty_handle, m.balance_after, m.created_at
       FROM cash_movements m
       LEFT JOIN participants c ON c.id = m.counterparty_id
      WHERE m.external_id = $1 AND m.participant_id = $2::bigint`,
    [externalId, participantId.toString()],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    kind: row.kind,
    amount: row.amount,
    counterpartyHandle: row.counterparty_handle,
    balanceAfter: row.balance_after,
    createdAt: row.created_at,
  };
}

export interface Recipient {
  id: bigint;
  cashAccountId: bigint;
  handle: string;
  displayName: string;
}

/**
 * The guest a handle names. Guests only: a bot's cash is unlimited in one
 * direction and meaningless in the other, so paying one is giving money to
 * nobody — and a lookup that found one would promise a transfer that then 404s.
 *
 * Shared by the transfer and the lookup route so the two cannot disagree.
 */
export async function findRecipient(pool: pg.Pool, handle: string): Promise<Recipient | null> {
  const { rows } = await pool.query<{
    id: bigint;
    cash_account_id: bigint;
    handle: string;
    display_name: string;
  }>(
    `SELECT id, cash_account_id, handle, display_name
       FROM participants WHERE handle = $1 AND kind = 'guest'`,
    [handle],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    cashAccountId: row.cash_account_id,
    handle: row.handle,
    displayName: row.display_name,
  };
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

  // Set inside the transaction; the value from the attempt that committed wins.
  let occurredAt = '';

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
    occurredAt,
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

  const recipient = await findRecipient(pool, request.toHandle);
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

  let occurredAt = '';

  const result = await post(pool, {
    kind: 'adjustment',
    legs: [
      { accountId: mover.cashAccountId, amount: -amount },
      { accountId: recipient.cashAccountId, amount },
    ],
    requireNonNegative: [mover.cashAccountId],
    mode: 'advisory',
    withinTransaction: async (client, transactionId) => {
      occurredAt = await recordMovement(client, {
        externalId: request.externalId,
        kind: 'transfer',
        participantId: mover.id,
        counterpartyId: recipient.id,
        amount,
        transactionId,
        cashAccountId: mover.cashAccountId,
      });

      await enqueue(client, {
        transactionId,
        accountId: mover.cashAccountId,
        eventType: 'transfer.sent',
        payload: {
          amount: amount.toString(),
          counterparty: recipient.displayName,
          counterpartyHandle: recipient.handle,
        },
      });

      await enqueue(client, {
        transactionId,
        accountId: recipient.cashAccountId,
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
    occurredAt,
    attempts: result.attempts,
    serializationFailures: result.serializationFailures,
    deadlocks: result.deadlocks,
  };
}

/** The parts of what a guest has put in. All non-negative except `net`. */
export interface Contributions {
  openingCredit: bigint;
  deposits: bigint;
  transfersIn: bigint;
  withdrawals: bigint;
  transfersOut: bigint;
  /** openingCredit + deposits + transfersIn − withdrawals − transfersOut. Can be negative. */
  net: bigint;
}

/**
 * Net cash a guest has put in, and its parts: the opening credit, plus deposits
 * and transfers received, less withdrawals and transfers sent.
 *
 * Read from the ledger rather than summed from `deposits` and
 * `cash_movements`: those tables say what was asked for, the entries say what
 * happened. A deposit request whose every delivery failed has a row there and
 * no entry here. Every non-trade movement on a cash account is one of these
 * three transaction kinds, and every trade is `buy` or `sell`.
 *
 * **One statement**, and the total is the sum of the parts rather than a second
 * query: the screen shows them as a sum that adds up, and two reads either side
 * of a committing transfer would not.
 *
 * Signs: the ledger stores a debit as a negative amount, so withdrawals and
 * transfers out are negated here to be shown as positive parts.
 *
 * Withdrawals count when they are **paid out**, not when they are requested.
 * Since the withdrawal saga, the `payout` leg is on the guest's hold account,
 * so that account's entries are read too; the `hold` and `release` legs move
 * the guest's own money between their two accounts and are neither money in
 * nor money out. A withdrawal in flight therefore leaves "put in" unchanged —
 * and equity counts the held cash, so it does not show as a loss.
 * (Withdrawals from before the saga paid out from the cash account directly,
 * and are still counted there.)
 *
 * Profit and loss is equity minus `net`. Measured against the fixed opening
 * balance instead, a deposit would read as profit.
 */
export async function contributionsOf(
  pool: pg.Pool,
  cashAccountId: bigint,
): Promise<Contributions> {
  const { rows } = await pool.query<{
    opening: bigint;
    deposits: bigint;
    transfers_in: bigint;
    withdrawals: bigint;
    transfers_out: bigint;
  }>(
    `WITH own AS (
       SELECT e.transaction_id, e.amount, t.kind,
              EXISTS (
                SELECT 1 FROM entries o JOIN accounts a ON a.id = o.account_id
                 WHERE o.transaction_id = e.transaction_id AND a.external_id = $2
              ) AS from_faucet
         FROM entries e
         JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE (e.account_id = $1::bigint OR e.account_id = (
                SELECT h.id FROM accounts h
                  JOIN participants p ON h.external_id = p.external_id || ':cash_hold'
                 WHERE p.cash_account_id = $1::bigint))
          AND t.kind IN ('funding', 'payout', 'adjustment')
     )
     SELECT
       coalesce(sum(amount) FILTER (WHERE kind = 'funding' AND from_faucet), 0)::bigint AS opening,
       coalesce(sum(amount) FILTER (WHERE kind = 'funding' AND NOT from_faucet), 0)::bigint AS deposits,
       coalesce(sum(amount) FILTER (WHERE kind = 'adjustment' AND amount > 0), 0)::bigint AS transfers_in,
       coalesce(-sum(amount) FILTER (WHERE kind = 'payout'), 0)::bigint AS withdrawals,
       coalesce(-sum(amount) FILTER (WHERE kind = 'adjustment' AND amount < 0), 0)::bigint AS transfers_out
       FROM own`,
    [cashAccountId.toString(), GUEST_FAUCET_EXTERNAL_ID],
  );

  const r = rows[0]!;
  return {
    openingCredit: r.opening,
    deposits: r.deposits,
    transfersIn: r.transfers_in,
    withdrawals: r.withdrawals,
    transfersOut: r.transfers_out,
    net: r.opening + r.deposits + r.transfers_in - r.withdrawals - r.transfers_out,
  };
}

export interface ActivityItem {
  id: bigint;
  /** The ledger transaction behind the event. NULL for rows older than migration 0013's reach. */
  transactionId: bigint | null;
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
    transaction_id: bigint | null;
    event_type: string;
    payload: unknown;
    occurred_at: string;
    published_at: string;
  }>(
    `SELECT id, transaction_id, event_type, payload, occurred_at, published_at
       FROM exchange_activity
      WHERE participant_id = $1::bigint
      ORDER BY id DESC
      LIMIT $2::int`,
    [participantId.toString(), limit],
  );

  return rows.map((r) => ({
    id: r.id,
    transactionId: r.transaction_id,
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

/** One line of a ledger transaction, as the guest it belongs to may see it. */
export interface LedgerLine {
  /** A display label — never an account id, a handle or a session subject. */
  account: string;
  /**
   * The ledger's own direction, unchanged: `debit` is a negative amount, value
   * leaving the account; `credit` is value entering it. That is also the
   * convention the screen explains, so there is nothing to flip — and flipping
   * it would invert every receipt.
   */
  direction: 'debit' | 'credit';
  /** Absolute amount, in minor units of `unit`. */
  amount: bigint;
  unit: string;
}

/**
 * The ledger lines behind a page of feed rows, in one query.
 *
 * Every leg of each transaction is returned, including the other side's: a
 * trade's four legs carry the amounts the guest already sees, and a receipt
 * that hid half of them would not balance. Labels come from a fixed set —
 * "Your cash", "<display name> · cash", "Payment provider · clearing",
 * "Outside world", "House · <unit>", "Your cash · on hold" — so an account id can never reach the
 * screen through a fallback.
 */
export async function ledgerLinesFor(
  pool: pg.Pool,
  viewer: { id: bigint },
  items: { transactionId: bigint | null; eventType: string }[],
): Promise<Map<bigint, LedgerLine[]>> {
  const ids = [
    ...new Set(items.flatMap((i) => (i.transactionId === null ? [] : [i.transactionId]))),
  ];
  const lines = new Map<bigint, LedgerLine[]>();
  if (ids.length === 0) return lines;

  const { rows } = await pool.query<{
    transaction_id: bigint;
    amount: bigint;
    unit: string;
    account_external_id: string;
    owner_id: bigint | null;
    owner_name: string | null;
    is_cash: boolean;
    is_hold: boolean;
  }>(
    `SELECT e.transaction_id, e.amount, e.unit, a.external_id AS account_external_id,
            coalesce(pc.id, pa.id, ph.id) AS owner_id,
            coalesce(pc.display_name, pa.display_name, ph.display_name) AS owner_name,
            (pc.id IS NOT NULL) AS is_cash,
            (ph.id IS NOT NULL) AS is_hold
       FROM entries e
       JOIN accounts a ON a.id = e.account_id
       LEFT JOIN participants pc ON pc.cash_account_id = a.id
       LEFT JOIN participants ph
              ON a.kind = 'customer_hold'
             AND ph.external_id = left(a.external_id, length(a.external_id) - length(':cash_hold'))
       LEFT JOIN participants pa
              ON a.asset_symbol IS NOT NULL
             AND pa.external_id = left(a.external_id, length(a.external_id) - length(a.asset_symbol) - 1)
      WHERE e.transaction_id = ANY($1::bigint[])
      ORDER BY e.transaction_id, e.id`,
    [ids.map(String)],
  );

  const kindOf = new Map(items.map((i) => [i.transactionId, i.eventType]));

  for (const r of rows) {
    let account: string;
    const what = r.is_hold ? 'cash · on hold' : r.is_cash ? 'cash' : r.unit;
    if (r.owner_id !== null && r.owner_id === viewer.id) {
      account = `Your ${what}`;
    } else if (r.owner_id !== null && r.owner_name !== null) {
      account = `${r.owner_name} · ${what}`;
    } else if (r.account_external_id === FUNDING_EXTERNAL_ID) {
      account = kindOf.get(r.transaction_id)?.startsWith('deposit')
        ? 'Payment provider · clearing'
        : 'Outside world';
    } else {
      account = `House · ${r.unit === 'USD' ? 'cash' : r.unit}`;
    }

    const list = lines.get(r.transaction_id) ?? [];
    list.push({
      account,
      direction: r.amount < 0n ? 'debit' : 'credit',
      amount: r.amount < 0n ? -r.amount : r.amount,
      unit: r.unit,
    });
    lines.set(r.transaction_id, list);
  }

  return lines;
}

/**
 * The stored external ids of the viewer's own orders and movements behind a
 * page of feed rows, keyed by transaction id. Filtered by `participant_id` in
 * both branches: a transfer's transaction also belongs to its recipient, and
 * the sender's id — which embeds the sender's session subject — must never be
 * returned to them.
 */
export async function ownReferencesFor(
  pool: pg.Pool,
  viewer: { id: bigint },
  transactionIds: bigint[],
): Promise<Map<bigint, string>> {
  const refs = new Map<bigint, string>();
  if (transactionIds.length === 0) return refs;

  const { rows } = await pool.query<{ transaction_id: bigint; external_id: string }>(
    `SELECT t.transaction_id, o.external_id
       FROM trades t
       JOIN book_orders o ON o.id IN (t.taker_order_id, t.maker_order_id)
      WHERE t.transaction_id = ANY($1::bigint[]) AND o.participant_id = $2::bigint
     UNION ALL
     SELECT m.transaction_id, m.external_id
       FROM cash_movements m
      WHERE m.transaction_id = ANY($1::bigint[]) AND m.participant_id = $2::bigint
     UNION ALL
     -- A withdrawal's later ledger transactions (paid out, or returned) carry
     -- the reference of the request that started it.
     SELECT tx.id, w.external_id
       FROM withdrawals w
       CROSS JOIN LATERAL (VALUES (w.settle_tx_id), (w.release_tx_id)) AS tx(id)
      WHERE tx.id = ANY($1::bigint[]) AND w.participant_id = $2::bigint`,
    [transactionIds.map(String), viewer.id.toString()],
  );
  for (const r of rows) refs.set(r.transaction_id, r.external_id);
  return refs;
}
