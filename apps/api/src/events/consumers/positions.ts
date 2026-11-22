import { z } from 'zod';
import type pg from 'pg';
import { applyFill, EMPTY_POSITION, type PositionState } from '../../exchange/positions.ts';
import type { Envelope } from '../envelope.ts';

/**
 * # The positions projection
 *
 * Built only from `trade.buy` / `trade.sell`. Everything it holds can be
 * dropped and rebuilt by replaying the topic from offset 0
 * (`npm run projections:replay -- positions`), and the reconciler checks it
 * against the ledger continuously.
 *
 * Runs inside the consumer's receipt transaction, so a redelivered trade is
 * rejected by `consumer_receipts` before it reaches here.
 */

export const isTradeEvent = (type: string): boolean =>
  type === 'trade.buy' || type === 'trade.sell';

const decimal = z.string().regex(/^[0-9]{1,19}$/);

const tradePayload = z.object({
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  quantity: decimal,
  notional: decimal,
});

export async function applyPosition(client: pg.PoolClient, event: Envelope): Promise<void> {
  // A malformed payload throws: not transient, so after the retry budget it
  // is dead-lettered rather than silently skipped.
  const payload = tradePayload.parse(event.payload);

  const { rows: who } = await client.query<{ id: bigint }>(
    `SELECT id FROM participants WHERE cash_account_id = $1::bigint`,
    [event.accountId.toString()],
  );
  const participantId = who[0]?.id;
  if (participantId === undefined) return;

  const { rows } = await client.query<{
    quantity: bigint;
    cost_basis: bigint;
    realised_pnl: bigint;
    buys: number;
    sells: number;
    last_event_id: bigint;
  }>(
    `SELECT quantity, cost_basis, realised_pnl, buys, sells, last_event_id
       FROM proj_positions
      WHERE participant_id = $1::bigint AND symbol = $2
      FOR UPDATE`,
    [participantId.toString(), payload.symbol],
  );

  const current = rows[0];
  const before: PositionState = current
    ? {
        quantity: current.quantity,
        costBasis: current.cost_basis,
        realisedPnl: current.realised_pnl,
        buys: current.buys,
        sells: current.sells,
      }
    : EMPTY_POSITION;

  if (current && event.eventId < current.last_event_id) {
    // Older than what is already applied, and not a duplicate (the receipt
    // would have stopped it). Applied anyway — dropping it would lose a fill —
    // and flagged, because average cost depends on order and the reconciler
    // should look at this position now.
    await client.query(
      `INSERT INTO reconciliation_findings (participant_id, symbol, kind, event_id, detail)
       VALUES ($1::bigint, $2, 'out_of_order', $3::bigint, $4)`,
      [
        participantId.toString(),
        payload.symbol,
        event.eventId.toString(),
        `arrived after event ${current.last_event_id.toString()}`,
      ],
    );
  }

  const after = applyFill(before, {
    side: payload.side,
    quantity: BigInt(payload.quantity),
    notional: BigInt(payload.notional),
  });

  await client.query(
    `INSERT INTO proj_positions
       (participant_id, symbol, quantity, cost_basis, realised_pnl, buys, sells, last_event_id, updated_at)
     VALUES ($1::bigint, $2, $3::bigint, $4::bigint, $5::bigint, $6, $7, $8::bigint, now())
     ON CONFLICT (participant_id, symbol) DO UPDATE
       SET quantity = EXCLUDED.quantity,
           cost_basis = EXCLUDED.cost_basis,
           realised_pnl = EXCLUDED.realised_pnl,
           buys = EXCLUDED.buys,
           sells = EXCLUDED.sells,
           last_event_id = greatest(proj_positions.last_event_id, EXCLUDED.last_event_id),
           updated_at = now()`,
    [
      participantId.toString(),
      payload.symbol,
      after.quantity.toString(),
      after.costBasis.toString(),
      after.realisedPnl.toString(),
      after.buys,
      after.sells,
      event.eventId.toString(),
    ],
  );
}
