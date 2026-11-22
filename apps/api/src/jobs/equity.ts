import type pg from 'pg';
import { contributionsOf } from '../exchange/cash.ts';
import { DEFAULT_MARKET } from '../exchange/engine.ts';
import { markValue } from '../exchange/positions.ts';

/**
 * # Equity snapshots
 *
 * The series behind Portfolio's equity chart. Run by a BullMQ Job Scheduler;
 * the job's **scheduled** time (not the time it happened to run) is the
 * bucket, so a job retried after a crash, or run twice, writes one row per
 * guest per slot — `PRIMARY KEY (participant_id, bucket)` with
 * `ON CONFLICT DO NOTHING`.
 *
 * Cash and holdings are read from the **ledger**, not the projection: an
 * equity figure that inherited a projection bug would hide it from the
 * reconciler's comparison. Cash includes any cash on hold for a withdrawal —
 * it is still the guest's until the rail confirms the payout.
 *
 * Only guests with activity in the last week are snapshotted. One row per
 * guest per slot is the cost; idle guests would be most of it.
 *
 * A slot missed while the worker process was down stays missed. The chart
 * shows a gap rather than an interpolated value nobody measured.
 */

const ACTIVE_WITHIN = '7 days';

export async function takeEquitySnapshots(pool: pg.Pool, bucket: Date): Promise<number> {
  const { rows: market } = await pool.query<{ last_price: bigint }>(
    'SELECT last_price FROM markets WHERE symbol = $1',
    [DEFAULT_MARKET],
  );
  const price = market[0]?.last_price;
  if (price === undefined) return 0;

  const { rows: guests } = await pool.query<{
    id: bigint;
    cash_account_id: bigint;
    cash: bigint;
    held: bigint;
    asset: bigint;
  }>(
    `SELECT p.id, p.cash_account_id,
            cash.balance AS cash,
            coalesce(hold.balance, 0)::bigint AS held,
            coalesce(asset.balance, 0)::bigint AS asset
       FROM participants p
       JOIN accounts cash ON cash.id = p.cash_account_id
       LEFT JOIN accounts asset ON asset.external_id = p.external_id || ':' || $1
       LEFT JOIN accounts hold ON hold.external_id = p.external_id || ':cash_hold'
      WHERE p.kind = 'guest'
        AND EXISTS (
          SELECT 1 FROM entries e
           WHERE e.account_id = p.cash_account_id
             AND e.created_at > now() - $2::interval
        )`,
    [DEFAULT_MARKET, ACTIVE_WITHIN],
  );

  let written = 0;
  for (const g of guests) {
    const contributed = await contributionsOf(pool, g.cash_account_id);
    const cash = g.cash + g.held;
    const holdingsValue = markValue(g.asset, price);
    const { rowCount } = await pool.query(
      `INSERT INTO equity_snapshots
         (participant_id, bucket, cash, holdings_value, equity, net_contributed)
       VALUES ($1::bigint, $2::timestamptz, $3::bigint, $4::bigint, $5::bigint, $6::bigint)
       ON CONFLICT (participant_id, bucket) DO NOTHING`,
      [
        g.id.toString(),
        bucket.toISOString(),
        cash.toString(),
        holdingsValue.toString(),
        (cash + holdingsValue).toString(),
        contributed.net.toString(),
      ],
    );
    written += rowCount ?? 0;
  }
  return written;
}

export interface EquityPoint {
  at: string;
  equity: bigint;
  netContributed: bigint;
}

export async function equitySeries(
  pool: pg.Pool,
  participantId: bigint,
  since: Date,
): Promise<EquityPoint[]> {
  const { rows } = await pool.query<{ bucket: string; equity: bigint; net_contributed: bigint }>(
    `SELECT bucket, equity, net_contributed FROM equity_snapshots
      WHERE participant_id = $1::bigint AND bucket >= $2::timestamptz
      ORDER BY bucket
      LIMIT 5000`,
    [participantId.toString(), since.toISOString()],
  );
  return rows.map((r) => ({ at: r.bucket, equity: r.equity, netContributed: r.net_contributed }));
}
