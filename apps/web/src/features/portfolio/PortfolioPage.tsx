import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { useApi } from '@/api/context';
import { freshness, useActivity, useMarket, useMe } from '@/api/queries';
import type { Me } from '@/api/types';
import { Button, Num } from '@/components/bits';
import { Panel } from '@/components/Panel';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import { groupHandle } from '@/lib/ids';
import { parseCash, showCash, showQty } from '@/lib/money';
import { QUOTE, SYMBOL } from '@/lib/rules';
import { showDateTime } from '@/lib/time';
import { GuestEntry } from '../GuestEntry';
import { ActivityFeed } from '../history/HistoryPage';
import { holdingsOf } from '../trade/YourMoney';
import { CashPanel } from './CashPanel';
import { EquityPanel, PositionPanel } from './PositionPanels';

function SumRow({
  sign,
  label,
  value,
  total,
}: {
  sign?: '+' | '−' | '=';
  label: React.ReactNode;
  value: string;
  total?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline gap-4 py-1',
        total && 'mt-1 border-t-2 border-ink pt-2 font-semibold',
      )}
    >
      <span className="num w-6 flex-none text-center text-ink-3" aria-hidden>
        {sign ?? ''}
      </span>
      <span className="min-w-0 flex-1 text-sm">{label}</span>
      <span className="num whitespace-nowrap text-md">{value}</span>
    </div>
  );
}

/** Three sums, each shown with its parts, that chain into profit and loss. A deposit raises both worth and what you put in, so it can never read as a gain. */
function Sums({ me, lastPrice }: { me: Me; lastPrice: string | undefined }) {
  const h = holdingsOf(me, lastPrice);
  const put = parseCash(me.netContributed);
  const c = me.contributions;
  if (!h || put === null)
    return <p className="px-7 pb-6 text-sm text-ink-3">Balances are not readable right now (—).</p>;
  const pnl = h.equity - put;
  const tone = pnl > 0n ? 'text-buy' : pnl < 0n ? 'text-sell' : 'text-ink';
  return (
    <div className="grid gap-x-12 gap-y-7 px-7 pb-7 md:grid-cols-3">
      <section>
        <h3 className="mb-1 text-sm text-ink-3">What it is worth now</h3>
        <SumRow label="Cash you can use" value={showCash(h.cashFree)} />
        <SumRow sign="+" label="Cash set aside for orders" value={showCash(h.cashAside)} />
        <SumRow
          sign="+"
          label={
            <>
              <Num>{showQty(h.coin)}</Num> {SYMBOL} at the last price,{' '}
              <Num>{showCash(lastPrice)}</Num>
            </>
          }
          value={showCash(h.coinValue)}
        />
        <SumRow sign="=" total label="Worth in total" value={showCash(h.equity)} />
      </section>
      <section>
        <h3 className="mb-1 text-sm text-ink-3">What you put in</h3>
        <SumRow label="Opening play money" value={showCash(c?.openingCredit)} />
        <SumRow sign="+" label="Deposits" value={showCash(c?.deposits)} />
        <SumRow sign="+" label="Received from others" value={showCash(c?.transfersIn)} />
        <SumRow sign="−" label="Withdrawals" value={showCash(c?.withdrawals)} />
        <SumRow sign="−" label="Sent to others" value={showCash(c?.transfersOut)} />
        <SumRow sign="=" total label="Put in, net" value={showCash(put)} />
      </section>
      <section>
        <h3 className="mb-1 text-sm text-ink-3">Profit or loss from trading</h3>
        <SumRow label="Worth in total" value={showCash(h.equity)} />
        <SumRow sign="−" label="Put in, net" value={showCash(put)} />
        <div className="mt-1 flex items-baseline gap-4 border-t-2 border-ink pt-2">
          <span className="num w-6 flex-none text-center text-ink-3" aria-hidden>
            =
          </span>
          <span className="flex-1 text-sm font-semibold">
            {pnl > 0n ? 'Profit' : pnl < 0n ? 'Loss' : 'Neither profit nor loss'}
          </span>
          <span className={cn('num whitespace-nowrap text-2xl font-semibold', tone)}>
            {pnl > 0n ? '▲ ' : pnl < 0n ? '▼ ' : ''}
            {showCash(pnl, { sign: true })}
          </span>
        </div>
        <p className="mt-2 text-sm text-ink-3">
          Measured against what you put in, not against the opening 10,000.00 — so deposits and
          transfers are not counted as gains or losses.
        </p>
      </section>
    </div>
  );
}

function Holding({
  label,
  total,
  free,
  unit,
  className,
  note,
}: {
  label: string;
  total: string;
  free?: string;
  unit: string;
  className?: string;
  note?: React.ReactNode;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-sm text-ink-3">{label}</dt>
      <dd className="num truncate text-2xl font-semibold" title={`${total} ${unit}`}>
        {total} <span className="font-ui text-md font-medium text-ink-2">{unit}</span>
      </dd>
      <dd className="text-sm text-ink-2">
        {note ?? (
          <>
            <Num>{free}</Num> you can use
          </>
        )}
      </dd>
    </div>
  );
}

function Leave() {
  const api = useApi();
  const client = useQueryClient();
  const navigate = useNavigate();
  const leave = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      client.clear();
      void navigate('/');
    },
  });
  return (
    <Panel title="Leave this account" className="flex-none">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4 px-7 pb-7">
        <p className="min-w-0 flex-1 basis-140 text-sm text-ink-2">
          Leaving clears the cookie from this browser. The account and its history stay on the
          server, but the cookie was the only key — nothing can reach it again, and there is no way
          to recover it.
        </p>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="danger">Leave this account</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle className="font-display text-xl font-semibold">
              Leave this account for good?
            </AlertDialogTitle>
            <AlertDialogDescription className="mt-3 text-ink-2">
              The cookie is the only key. Once it is cleared, this guest's balances, orders and
              history cannot be reached again by anyone — including you. Open orders stay in the
              book.
            </AlertDialogDescription>
            <div className="mt-8 flex justify-end gap-4">
              <AlertDialogCancel asChild>
                <Button>Stay</Button>
              </AlertDialogCancel>
              <AlertDialogAction asChild>
                <Button variant="danger-solid" onClick={() => leave.mutate()}>
                  Leave for good
                </Button>
              </AlertDialogAction>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Panel>
  );
}

export function PortfolioPage() {
  const me = useMe();
  const market = useMarket();
  const activity = useActivity();
  if (me.isPending) return <p className="p-10 text-ink-3">Loading your account…</p>;
  if (!me.data) return <GuestEntry page="portfolio" />;
  const guest = me.data;
  const meFresh = freshness(me);
  const lastPrice = market.data?.market.lastPrice;
  const h = holdingsOf(guest, lastPrice);
  const put = parseCash(guest.netContributed);
  const pnl = h && put !== null ? h.equity - put : null;
  return (
    <div className="mx-auto flex max-w-720 flex-col gap-6 px-4 py-5 md:gap-7 md:px-10 md:py-7">
      <Panel
        title={
          <span
            className="block max-w-[70vw] truncate md:max-w-300"
            title={guest.participant.displayName}
          >
            {guest.participant.displayName}
          </span>
        }
        aside={
          <span className="text-sm text-ink-3">
            handle <Num>{groupHandle(guest.handle)}</Num> · since{' '}
            <Num>{showDateTime(guest.participant.createdAt)}</Num> UTC
          </span>
        }
        staleSince={meFresh.stale ? meFresh.asOf : null}
        className="flex-none"
      >
        <dl className="grid grid-cols-1 gap-x-12 gap-y-5 px-7 pb-6 md:grid-cols-3">
          <Holding
            label="Worth in total"
            total={h ? showCash(h.equity) : '—'}
            unit={QUOTE}
            note={
              pnl === null ? (
                '—'
              ) : (
                <>
                  <Num className={pnl > 0n ? 'text-buy' : pnl < 0n ? 'text-sell' : ''}>
                    {pnl > 0n ? '▲ ' : pnl < 0n ? '▼ ' : ''}
                    {showCash(pnl, { sign: true })}
                  </Num>{' '}
                  {pnl < 0n ? 'loss' : 'profit'} against what you put in
                </>
              )
            }
          />
          <Holding
            label="Cash"
            total={showCash(guest.balances.cash)}
            free={showCash(guest.balances.cashAvailable)}
            unit={QUOTE}
          />
          <Holding
            label="Coins"
            total={showQty(guest.balances.asset)}
            free={showQty(guest.balances.assetAvailable)}
            unit={SYMBOL}
          />
        </dl>
        <Sums me={guest} lastPrice={lastPrice} />
      </Panel>

      <PositionPanel />
      <EquityPanel />

      <div className="grid items-start gap-6 md:gap-7 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <CashPanel me={guest} />
        <Panel
          title="Latest activity"
          actions={
            <Link
              to="/history"
              className="rounded-tag text-sm text-info underline underline-offset-4"
            >
              All activity, trades and orders
            </Link>
          }
          staleSince={freshness(activity).stale ? freshness(activity).asOf : null}
          className="max-h-300"
        >
          <ActivityFeed
            events={activity.data?.events ?? []}
            pending={activity.data?.pending ?? guest.pendingEvents}
            limit={12}
            compact
          />
        </Panel>
      </div>
      <Leave />
    </div>
  );
}
