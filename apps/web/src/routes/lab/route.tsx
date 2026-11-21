import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { cn } from '@/lib/cn';

export const Route = createFileRoute('/lab')({ component: LabLayout });

/**
 * The seven original pages, in the order they tell the story: what you hold,
 * how you trade, what the ledger recorded, how it balances, what settled it,
 * what happens under load, and the evidence for all of it.
 */
const NAV = [
  { to: '/lab', label: 'Dashboard' },
  { to: '/lab/trade', label: 'House trade' },
  { to: '/lab/transactions', label: 'Transactions' },
  { to: '/lab/ledger', label: 'Account ledger' },
  { to: '/lab/settlements', label: 'Settlements' },
  { to: '/lab/chaos', label: 'Chaos' },
  { to: '/lab/evidence', label: 'Evidence' },
] as const;

/**
 * The ledger lab: everything this project was before it had an order book.
 *
 * Kept whole and kept reachable, but out of the main navigation. These pages
 * read **seeded benchmark data** through the legacy API — a different set of
 * accounts from the exchange's guests and bots, priced from a frozen reference
 * table rather than from trades. The strip below says so, because a visitor
 * arriving from the trading screen would otherwise assume the balances here are
 * theirs.
 */
function LabLayout(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div className="border-ink-800 bg-ink-900/60 space-y-3 rounded-lg border px-4 py-3">
        <p className="text-ink-400 text-xs">
          <strong className="text-ink-200 font-medium">Ledger lab.</strong> The correctness
          demonstrations the exchange is built on. These pages show seeded demo accounts and frozen
          reference prices — not your guest account, and not the live book.
        </p>
        <nav className="flex flex-wrap items-center gap-1">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeProps={{ className: 'bg-ink-800 text-ink-50' }}
              inactiveProps={{ className: 'text-ink-400 hover:text-ink-100 hover:bg-ink-900' }}
              className={cn('rounded-md px-2.5 py-1.5 text-sm transition-colors')}
              // `/lab` is a prefix of every lab path; match it exactly or the
              // Dashboard link is always active.
              {...(item.to === '/lab' ? { activeOptions: { exact: true } } : {})}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>

      <Outlet />
    </div>
  );
}
