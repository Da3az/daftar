import { divRound, notional } from '@daftar/money';
import type pg from 'pg';

/**
 * # Positions: average cost and realised P&L, from fills
 *
 * One pure function, `applyFill`, used twice: by the positions consumer, fed
 * from the event log, and by the reconciler, fed from the `trades` table. If
 * the two disagree, the inputs differed — an event was lost, duplicated or
 * reordered on its way through the log — because the arithmetic is shared.
 *
 * Exact integers throughout. Quantities are in 1e-8 coin units, cash in
 * minor units; `notional` is the cash that changed hands for the fill, taken
 * from the fill itself rather than recomputed, so the basis is what the
 * ledger moved to the cent.
 */

export interface PositionState {
  quantity: bigint;
  costBasis: bigint;
  realisedPnl: bigint;
  buys: number;
  sells: number;
}

export interface Fill {
  side: 'buy' | 'sell';
  quantity: bigint;
  notional: bigint;
}

export const EMPTY_POSITION: PositionState = {
  quantity: 0n,
  costBasis: 0n,
  realisedPnl: 0n,
  buys: 0,
  sells: 0,
};

export class OversoldError extends Error {
  override name = 'OversoldError';
}

/**
 * Average cost. On a sell the basis removed is
 * `floor(costBasis × sold / quantity)` — the floor leaves the remainder in the
 * basis, so cost is conserved exactly across any sequence of partial sells and
 * a position sold to zero has exactly zero basis left.
 */
export function applyFill(state: PositionState, fill: Fill): PositionState {
  if (fill.quantity <= 0n) throw new RangeError('fill quantity must be positive');

  if (fill.side === 'buy') {
    return {
      ...state,
      quantity: state.quantity + fill.quantity,
      costBasis: state.costBasis + fill.notional,
      buys: state.buys + 1,
    };
  }

  if (fill.quantity > state.quantity) {
    // A guest cannot sell what they do not hold — the ledger forbids it. So a
    // projection that sees this has missed a buy.
    throw new OversoldError(
      `sell of ${fill.quantity.toString()} against a position of ${state.quantity.toString()}`,
    );
  }

  const removed =
    fill.quantity === state.quantity
      ? state.costBasis
      : (state.costBasis * fill.quantity) / state.quantity;

  return {
    quantity: state.quantity - fill.quantity,
    costBasis: state.costBasis - removed,
    realisedPnl: state.realisedPnl + (fill.notional - removed),
    buys: state.buys,
    sells: state.sells + 1,
  };
}

/**
 * Average entry price in minor units per whole coin, rounded half-up to the
 * cent. `null` for a flat position.
 */
export function averageEntryPrice(
  state: Pick<PositionState, 'quantity' | 'costBasis'>,
): bigint | null {
  if (state.quantity === 0n) return null;
  return divRound(state.costBasis * 100_000_000n, state.quantity);
}

/** Mark-to-market value of a position — the same rounding as a fill's notional. */
export const markValue = (quantity: bigint, price: bigint): bigint => notional(quantity, price);

/**
 * The same position recomputed from the source of truth: every fill in
 * `trades` that touched one of this participant's orders, in trade order.
 *
 * Trade id order is commit order here — matching runs under one row lock per
 * market — and within one trade where a guest was on both sides the buy is
 * taken first, the order in which the engine enqueues the two events.
 */
export async function positionFromTrades(
  client: pg.Pool | pg.PoolClient,
  participantId: bigint,
  symbol: string,
): Promise<PositionState> {
  const { rows } = await client.query<{ side: 'buy' | 'sell'; quantity: bigint; notional: bigint }>(
    `SELECT o.side, t.quantity, t.notional
       FROM trades t
       JOIN book_orders o ON o.id IN (t.taker_order_id, t.maker_order_id)
      WHERE o.participant_id = $1::bigint AND t.symbol = $2
      ORDER BY t.id, (o.side = 'sell')`,
    [participantId.toString(), symbol],
  );

  let state = EMPTY_POSITION;
  for (const row of rows) state = applyFill(state, row);
  return state;
}

export interface StoredPosition extends PositionState {
  participantId: bigint;
  symbol: string;
  lastEventId: bigint;
  updatedAt: string;
}

export async function readPosition(
  client: pg.Pool | pg.PoolClient,
  participantId: bigint,
  symbol: string,
): Promise<StoredPosition | null> {
  const { rows } = await client.query<{
    quantity: bigint;
    cost_basis: bigint;
    realised_pnl: bigint;
    buys: number;
    sells: number;
    last_event_id: bigint;
    updated_at: string;
  }>(
    `SELECT quantity, cost_basis, realised_pnl, buys, sells, last_event_id, updated_at
       FROM proj_positions WHERE participant_id = $1::bigint AND symbol = $2`,
    [participantId.toString(), symbol],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    participantId,
    symbol,
    quantity: r.quantity,
    costBasis: r.cost_basis,
    realisedPnl: r.realised_pnl,
    buys: r.buys,
    sells: r.sells,
    lastEventId: r.last_event_id,
    updatedAt: r.updated_at,
  };
}
