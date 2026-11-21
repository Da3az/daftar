import type { MarketSnapshot } from '@/api/types';
import { cn } from '@/lib/cn';
import { compareDecimal, parseCash, showCash, showPercentChange, showQty } from '@/lib/money';
import { QUOTE } from '@/lib/rules';
import { showTime } from '@/lib/time';

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="whitespace-nowrap text-sm text-ink-3">{label}</dt>
      <dd className="num whitespace-nowrap text-md font-medium md:text-lg">{children}</dd>
    </div>
  );
}

/** Symbol, last traded price, and the day's figures. Renders its structure before any data arrives. */
export function MarketStrip({ snapshot }: { snapshot: MarketSnapshot | undefined }) {
  const market = snapshot?.market;
  const stats = snapshot?.stats;
  const open = stats?.open ?? null;
  const direction = market && open ? compareDecimal(market.lastPrice, open, 2) : 0;
  const last = parseCash(market?.lastPrice);
  const base = parseCash(open);
  const change = last !== null && base !== null ? last - base : null;
  const tone =
    direction > 0
      ? 'bg-buy-wash text-buy'
      : direction < 0
        ? 'bg-sell-wash text-sell'
        : 'bg-well text-ink-2';
  return (
    <section
      aria-label="Market"
      className="flex flex-wrap items-center gap-x-15 gap-y-4 rounded-panel border border-line bg-surface px-7 py-5 xl:px-10"
    >
      <div>
        <h1 className="font-display text-xl font-semibold">
          {market?.symbol ?? 'DFT'} / {QUOTE}
        </h1>
        <p className="text-sm text-ink-3">{market?.displayName ?? 'Daftar Token'}</p>
      </div>
      <div
        className="font-display text-3xl font-semibold tracking-tight tabular-nums"
        aria-label="Last traded price"
      >
        {showCash(market?.lastPrice)}
      </div>
      <div
        className={cn('num whitespace-nowrap rounded-pill px-5 py-2 text-md font-semibold', tone)}
      >
        {change === null ? (
          'No trades in 24 h'
        ) : (
          <>
            {direction > 0 ? '▲ ' : direction < 0 ? '▼ ' : ''}
            {showCash(change, { sign: true })} · {showPercentChange(market?.lastPrice, open)}{' '}
            <span className="font-ui font-medium">in 24 h</span>
          </>
        )}
      </div>
      <dl className="flex flex-wrap gap-x-12 gap-y-2">
        <Stat label="24h high">{showCash(stats?.high)}</Stat>
        <Stat label="24h low">{showCash(stats?.low)}</Stat>
        <Stat label="24h volume">
          {showQty(stats?.volume)}{' '}
          <span className="text-sm text-ink-3">{market?.symbol ?? 'DFT'}</span>
        </Stat>
        <Stat label="24h trades">
          {typeof stats?.trades === 'number' ? stats.trades.toLocaleString('en-US') : '—'}
        </Stat>
        <Stat label="Last trade">
          {showTime(market?.lastTradeAt)} <span className="text-sm text-ink-3">UTC</span>
        </Stat>
      </dl>
    </section>
  );
}
