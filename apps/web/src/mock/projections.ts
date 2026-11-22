import type { EquityPoint, Me, OwnFill, Position } from '@/api/types';
import { formatCash, formatQty, notional, parseCash, parseQty } from '@/lib/money';

/* The mock's stand-ins for the server's projections. Same arithmetic as the
   server's `applyFill` — average cost, the basis removed on a sell floored so
   the remainder stays in the basis — computed over the mock engine's fills. */

export function positionFromFills(fills: OwnFill[], symbol: string, lastPrice: string): Position {
  let quantity = 0n;
  let costBasis = 0n;
  let realised = 0n;
  let buys = 0;
  let sells = 0;

  // Fills arrive newest first; average cost depends on order.
  const ordered = [...fills]
    .filter((f) => f.symbol === symbol)
    .sort((a, b) => (BigInt(a.tradeId) < BigInt(b.tradeId) ? -1 : 1));

  for (const f of ordered) {
    const q = parseQty(f.quantity) ?? 0n;
    const n = parseCash(f.notional) ?? 0n;
    if (q <= 0n) continue;
    if (f.side === 'buy') {
      quantity += q;
      costBasis += n;
      buys += 1;
    } else {
      const removed = q >= quantity ? costBasis : (costBasis * q) / quantity;
      quantity = q >= quantity ? 0n : quantity - q;
      costBasis -= removed;
      realised += n - removed;
      sells += 1;
    }
  }

  const price = parseCash(lastPrice) ?? 0n;
  const value = notional(price, quantity);
  const avg = quantity === 0n ? null : (costBasis * 100_000_000n * 2n + quantity) / (quantity * 2n);

  return {
    symbol,
    quantity: formatQty(quantity),
    costBasis: formatCash(costBasis),
    averageEntryPrice: avg === null ? null : formatCash(avg),
    lastPrice: formatCash(price),
    marketValue: formatCash(value),
    realisedPnl: formatCash(realised),
    unrealisedPnl: formatCash(value - costBasis),
    buys,
    sells,
    lastEventId: ordered.length > 0 ? ordered[ordered.length - 1]!.tradeId : null,
    asOf: ordered.length > 0 ? ordered[ordered.length - 1]!.createdAt : null,
  };
}

/** One point a minute, recorded as the mock is read — there is no snapshot job in the browser. */
export class EquityRecorder {
  readonly #points: EquityPoint[] = [];

  record(me: Me, lastPrice: string, nowMs: number): EquityPoint[] {
    const bucket = Math.floor(nowMs / 60_000) * 60_000;
    const at = new Date(bucket).toISOString();
    if (this.#points.at(-1)?.at !== at) {
      const cash = parseCash(me.balances.cash) ?? 0n;
      const coin = parseQty(me.balances.asset) ?? 0n;
      const equity = cash + notional(parseCash(lastPrice) ?? 0n, coin);
      this.#points.push({ at, equity: formatCash(equity), netContributed: me.netContributed });
      if (this.#points.length > 2_000) this.#points.shift();
    }
    return [...this.#points];
  }

  clear(): void {
    this.#points.length = 0;
  }
}
