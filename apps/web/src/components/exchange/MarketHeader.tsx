import { CASH_SCALE, compareDecimal, formatCash } from '@/lib/money';
import { percentChange, trimQuantity, type MarketSnapshot } from '@/lib/exchange';

/** The strip above the chart: last price and the trailing 24 hours. */
export function MarketHeader({
  snapshot,
}: {
  snapshot: MarketSnapshot | undefined;
}): React.JSX.Element {
  const market = snapshot?.market;
  const stats = snapshot?.stats;

  const change = percentChange(stats?.open ?? null, market?.lastPrice ?? null);
  const direction =
    market && stats?.open ? compareDecimal(market.lastPrice, stats.open, CASH_SCALE) : 0;
  const tone = direction > 0 ? 'text-credit' : direction < 0 ? 'text-debit' : 'text-ink-100';

  return (
    <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
      <div>
        <h1 className="text-ink-50 text-lg font-semibold">
          {market?.symbol ?? '—'}
          <span className="text-ink-500 font-normal"> / USD</span>
        </h1>
        <p className="text-ink-400 text-xs">{market?.displayName ?? ' '}</p>
      </div>

      <div>
        <p className={`num text-2xl font-semibold ${tone}`}>
          {market ? formatCash(market.lastPrice) : '—'}
        </p>
        <p className={`num text-xs ${tone}`}>{change ?? '—'} · 24h</p>
      </div>

      <Stat label="24h high" value={stats?.high ? formatCash(stats.high) : '—'} />
      <Stat label="24h low" value={stats?.low ? formatCash(stats.low) : '—'} />
      <Stat
        label="24h volume"
        value={stats && market ? `${trimQuantity(stats.volume)} ${market.symbol}` : '—'}
      />
      <Stat label="24h trades" value={stats ? stats.trades.toLocaleString('en-US') : '—'} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <p className="text-ink-500 text-[11px]">{label}</p>
      <p className="num text-ink-100 text-sm">{value}</p>
    </div>
  );
}
