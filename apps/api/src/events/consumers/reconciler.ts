import { z } from 'zod';
import type pg from 'pg';
import type { Logger } from 'pino';
import { positionAccountExternalId } from '../../exchange/engine.ts';
import { positionFromTrades, readPosition } from '../../exchange/positions.ts';
import { reconcileFindings } from '../../observability/metrics.ts';
import type { Envelope } from '../envelope.ts';

/**
 * # The reconciler
 *
 * Checks the positions projection against the ledger and records how long a
 * divergence went unnoticed.
 *
 * It is its own consumer group, so it sees every trade event independently of
 * the positions consumer — and therefore cannot assume the projection has
 * applied an event yet. The consumer only marks the account *dirty*; a sweep
 * checks a dirty account once the projection's `last_event_id` has caught up
 * to the event that dirtied it. A projection that does not catch up within
 * `LAG_LIMIT_MS` is itself a finding.
 *
 * Two sources of truth, for two different questions:
 *
 * - **quantity** against the participant's position *account balance* in the
 *   ledger — what the guest actually holds;
 * - **cost basis and realised P&L** against `positionFromTrades()`, the same
 *   arithmetic over the `trades` table. The ledger has no notion of cost, but
 *   `trades` is written in the same transaction as the entries, so it is the
 *   ledger's record of what was paid.
 *
 * A full sweep every `FULL_SWEEP_EVERY` cycles re-dirties every position, so
 * a divergence introduced without any new event — a hand edit, the chaos
 * endpoint — is still found.
 */

const LAG_LIMIT_MS = 60_000;
const FULL_SWEEP_EVERY = 12;

const tradeSymbol = z.object({ symbol: z.string().min(1) });

/** Consumer side: mark the account dirty. Runs in the receipt transaction. */
export async function markDirty(client: pg.PoolClient, event: Envelope): Promise<void> {
  const parsed = tradeSymbol.safeParse(event.payload);
  if (!parsed.success) return;

  await client.query(
    `INSERT INTO reconcile_dirty (participant_id, symbol, event_id)
     SELECT p.id, $2, $3::bigint FROM participants p WHERE p.cash_account_id = $1::bigint
     ON CONFLICT (participant_id, symbol) DO UPDATE
       SET event_id = greatest(reconcile_dirty.event_id, EXCLUDED.event_id)`,
    [event.accountId.toString(), parsed.data.symbol, event.eventId.toString()],
  );
}

interface Finding {
  participantId: bigint;
  symbol: string;
  kind: string;
  expected: bigint | null;
  actual: bigint | null;
  eventId: bigint | null;
  detail?: string;
}

/**
 * Record a finding unless the same divergence is already on file — a sweep
 * that keeps seeing one broken position writes one row, not one a minute.
 * Ties it to the earliest undetected drift injection for the position, which
 * is what turns a finding into a time-to-detect.
 */
async function record(pool: pg.Pool, f: Finding): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount: existing } = await client.query(
      `SELECT 1 FROM reconciliation_findings
        WHERE participant_id = $1::bigint AND symbol = $2 AND kind = $3
          AND expected IS NOT DISTINCT FROM $4::bigint
          AND actual IS NOT DISTINCT FROM $5::bigint
        LIMIT 1`,
      [
        f.participantId.toString(),
        f.symbol,
        f.kind,
        f.expected?.toString() ?? null,
        f.actual?.toString() ?? null,
      ],
    );
    if ((existing ?? 0) > 0) {
      await client.query('ROLLBACK');
      return false;
    }

    const { rows: injections } = await client.query<{ id: bigint; injected_at: string }>(
      `SELECT id, injected_at FROM projection_drift_injections
        WHERE participant_id = $1::bigint AND symbol = $2 AND detected_at IS NULL
        ORDER BY injected_at
        LIMIT 1
        FOR UPDATE`,
      [f.participantId.toString(), f.symbol],
    );
    const injection = injections[0];

    await client.query(
      `INSERT INTO reconciliation_findings
         (participant_id, symbol, kind, expected, actual, event_id, introduced_at, detail)
       VALUES ($1::bigint, $2, $3, $4::bigint, $5::bigint, $6::bigint, $7::timestamptz, $8)`,
      [
        f.participantId.toString(),
        f.symbol,
        f.kind,
        f.expected?.toString() ?? null,
        f.actual?.toString() ?? null,
        f.eventId?.toString() ?? null,
        injection?.injected_at ?? null,
        f.detail ?? null,
      ],
    );
    if (injection) {
      await client.query(
        'UPDATE projection_drift_injections SET detected_at = now() WHERE id = $1::bigint',
        [injection.id.toString()],
      );
    }
    await client.query('COMMIT');
    reconcileFindings.inc({ kind: f.kind });
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

interface DirtyRow {
  participant_id: bigint;
  external_id: string;
  symbol: string;
  event_id: bigint;
  marked_at: string;
}

/** Check one dirty position. Returns whether it was settled (checked or given up on). */
async function checkOne(pool: pg.Pool, row: DirtyRow): Promise<boolean> {
  const projected = await readPosition(pool, row.participant_id, row.symbol);

  if (!projected || projected.lastEventId < row.event_id) {
    const waitedMs = Date.now() - Date.parse(row.marked_at);
    if (waitedMs < LAG_LIMIT_MS) return false; // not caught up yet; look again next sweep
    await record(pool, {
      participantId: row.participant_id,
      symbol: row.symbol,
      kind: 'projection_lagging',
      expected: row.event_id,
      actual: projected?.lastEventId ?? null,
      eventId: row.event_id,
      detail: `projection behind for ${String(Math.round(waitedMs / 1000))} s`,
    });
    return false;
  }

  const truth = await positionFromTrades(pool, row.participant_id, row.symbol);

  const { rows: balances } = await pool.query<{ balance: bigint }>(
    'SELECT balance FROM accounts WHERE external_id = $1',
    [positionAccountExternalId(row.external_id, row.symbol)],
  );
  const held = balances[0]?.balance ?? 0n;

  const checks: [string, bigint, bigint][] = [
    ['quantity_mismatch', held, projected.quantity],
    ['cost_basis_mismatch', truth.costBasis, projected.costBasis],
    ['realised_mismatch', truth.realisedPnl, projected.realisedPnl],
  ];
  for (const [kind, expected, actual] of checks) {
    if (expected !== actual) {
      await record(pool, {
        participantId: row.participant_id,
        symbol: row.symbol,
        kind,
        expected,
        actual,
        eventId: projected.lastEventId,
      });
    }
  }
  return true;
}

export interface ReconcilerSweeper {
  stop: () => Promise<void>;
}

export function startReconcileSweeps(
  pool: pg.Pool,
  options: { intervalMs: number; log: Logger },
): ReconcilerSweeper {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let cycles = 0;

  const sweep = async (): Promise<void> => {
    cycles += 1;
    if (cycles % FULL_SWEEP_EVERY === 0) {
      await pool.query(
        `INSERT INTO reconcile_dirty (participant_id, symbol, event_id)
         SELECT participant_id, symbol, last_event_id FROM proj_positions
         ON CONFLICT (participant_id, symbol) DO NOTHING`,
      );
    }

    const { rows } = await pool.query<DirtyRow>(
      `SELECT d.participant_id, p.external_id, d.symbol, d.event_id, d.marked_at
         FROM reconcile_dirty d JOIN participants p ON p.id = d.participant_id
        ORDER BY d.marked_at
        LIMIT 200`,
    );

    for (const row of rows) {
      if (stopped) return;
      const settled = await checkOne(pool, row);
      if (settled) {
        // Only if not re-dirtied by a newer event meanwhile.
        await pool.query(
          `DELETE FROM reconcile_dirty
            WHERE participant_id = $1::bigint AND symbol = $2 AND event_id = $3::bigint`,
          [row.participant_id.toString(), row.symbol, row.event_id.toString()],
        );
      }
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      inFlight = sweep()
        .catch((err: unknown) => options.log.warn({ err }, 'reconcile sweep failed'))
        .then(schedule);
    }, options.intervalMs);
  };

  schedule();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
