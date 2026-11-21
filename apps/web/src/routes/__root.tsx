import { Link, Outlet, createRootRoute } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatCash } from '@/lib/money';
import { useMe } from '@/lib/exchange';

/** The exchange is the product; two pages cover it. */
const NAV = [
  { to: '/', label: 'Trade' },
  { to: '/portfolio', label: 'Portfolio' },
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
            <span className="text-ink-500 ml-2 text-xs">beta exchange</span>
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

          <div className="ml-auto flex items-center gap-4">
            <AccountChip />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>

      <footer className="border-ink-800 text-ink-500 mt-12 border-t px-4 py-6 text-xs">
        <div className="mx-auto max-w-7xl space-y-1">
          <p>
            DFT is a made-up coin that exists only here. Its price is whatever the last two
            participants agreed on — there is no outside feed — and most of those participants are
            bots.
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
            (Apache-2.0).
          </p>
        </div>
      </footer>
    </div>
  );
}

/**
 * The guest's name and available cash, on every page.
 *
 * Renders nothing without a session rather than a "sign in" button: the way in
 * is the order ticket on the Trade page, and a second, different-looking entry
 * point in the header would be a second thing to keep in step with it.
 */
function AccountChip(): React.JSX.Element | null {
  const me = useMe();
  if (!me.data) return null;

  return (
    <Link
      to="/portfolio"
      className="border-ink-800 hover:border-ink-600 flex items-baseline gap-2 rounded-md border px-2.5 py-1 text-xs transition-colors"
    >
      <span className="text-ink-400">{me.data.participant.displayName}</span>
      <span className="num text-ink-100">{formatCash(me.data.balances.cashAvailable)}</span>
    </Link>
  );
}

/**
 * The demo banner.
 *
 * Not dismissible, and deliberately at the very top of the document rather than
 * inside the scroll container. This interface shows balances in dollars, a buy
 * button and a moving price — every visual cue says "real money". One sentence
 * saying otherwise, always visible, is the minimum.
 */
function DemoBanner(): React.JSX.Element {
  return (
    <div
      role="status"
      className="bg-warn/15 text-warn border-warn/30 flex items-center justify-center gap-2 border-b px-4 py-2 text-center text-xs"
    >
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
      <span>
        <strong className="font-semibold">Beta, play money.</strong> No real funds, no real coin,
        nothing to withdraw. Balances are fictional and the other traders are mostly bots.
      </span>
    </div>
  );
}
