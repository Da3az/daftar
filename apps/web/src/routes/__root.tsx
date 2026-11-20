import { Link, Outlet, createRootRoute } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * The seven pages, in the order they tell the story: what you hold, how you
 * trade, what the ledger recorded, how it balances, what settled it, what
 * happens under load, and the evidence for all of it.
 */
const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/trade', label: 'Trade' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/ledger', label: 'Account ledger' },
  { to: '/settlements', label: 'Settlements' },
  { to: '/chaos', label: 'Chaos' },
  { to: '/evidence', label: 'Evidence' },
] as const;

export const Route = createRootRoute({ component: RootLayout });

function RootLayout(): React.JSX.Element {
  return (
    <div className="min-h-dvh">
      <DemoBanner />

      <header className="border-ink-800 bg-ink-950/80 sticky top-0 z-10 border-b backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
          <Link to="/" className="shrink-0">
            <span className="text-ink-50 text-base font-semibold tracking-tight">daftar</span>
            {/* دفتر — "ledger". The name is the thesis. */}
            <span className="text-ink-500 ml-2 text-xs">ledger-first brokerage</span>
          </Link>

          <nav className="flex flex-wrap items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                /*
                 * `activeProps` rather than reading the location and comparing
                 * strings. TanStack Router resolves the active state against
                 * the matched route, so a nested or parameterised route still
                 * highlights its parent correctly.
                 */
                activeProps={{ className: 'bg-ink-800 text-ink-50' }}
                inactiveProps={{ className: 'text-ink-400 hover:text-ink-100 hover:bg-ink-900' }}
                className={cn('rounded-md px-2.5 py-1.5 text-sm transition-colors')}
                /*
                 * Exact matching for the index route only; without it `/` is a
                 * prefix of every path and the Dashboard link is always active.
                 *
                 * Spread conditionally rather than passing `undefined`:
                 * `exactOptionalPropertyTypes` is on repo-wide, so an explicit
                 * `undefined` is a different type from an absent property and
                 * is rejected. The spread omits the key entirely.
                 */
                {...(item.to === '/' ? { activeOptions: { exact: true } } : {})}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>

      <footer className="border-ink-800 text-ink-500 mt-12 border-t px-4 py-6 text-xs">
        <div className="mx-auto max-w-7xl space-y-1">
          <p>
            Prices shown on the chart are live market data, for display only. Orders are priced from
            a frozen reference price and the order endpoint makes no network call — see the Trade
            page.
          </p>
          <p>
            Charting by{' '}
            <a
              href="https://www.tradingview.com/lightweight-charts/"
              className="text-ink-400 underline hover:text-ink-200"
              target="_blank"
              rel="noreferrer noopener"
            >
              TradingView Lightweight Charts
            </a>{' '}
            (Apache-2.0). Market data from Binance public endpoints.
          </p>
        </div>
      </footer>
    </div>
  );
}

/**
 * The demo banner.
 *
 * Not dismissible, and deliberately at the very top of the document rather than
 * inside the scroll container. This interface shows balances in dollars, a buy
 * button, and a settlements page naming a bank — every visual cue says "real
 * money". One sentence saying otherwise, always visible, is the minimum.
 */
function DemoBanner(): React.JSX.Element {
  return (
    <div
      role="status"
      className="bg-warn/15 text-warn border-warn/30 flex items-center justify-center gap-2 border-b px-4 py-2 text-center text-xs"
    >
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
      <span>
        <strong className="font-semibold">Demo.</strong> No real funds, no real trading, no real
        bank. Balances are fictional and every account here is seeded data.
      </span>
    </div>
  );
}
