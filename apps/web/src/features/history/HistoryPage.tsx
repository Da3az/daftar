import { Fragment, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { freshness, useActivity, useFills, useMe, useOrders } from '@/api/queries';
import type { ActivityEvent } from '@/api/types';
import { Button, LinkButton, Num, SideTag, StateChip } from '@/components/bits';
import { Panel, td, th } from '@/components/Panel';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/cn';
import { showCash, showQty } from '@/lib/money';
import { showDateTime, showLag } from '@/lib/time';
import { GuestEntry } from '../GuestEntry';
import { downloadCsv } from './csv';
import { describeEvent, describeStatus } from './describe';
import { Ledger } from './Ledger';
import { useReceipt } from './Receipt';

const row = 'h-(--row-history) border-b border-line';
const right = 'text-right';

/** Shows what is waiting and lets new rows in only when asked, so nothing moves under the cursor. */
export function ActivityFeed({
  events,
  pending,
  limit,
  compact,
}: {
  events: ActivityEvent[];
  pending: number;
  limit?: number;
  compact?: boolean;
}) {
  const [live, setLive] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const admitted = useRef<Set<string> | null>(null);
  const [, bump] = useState(0);
  const receipt = useReceipt();
  if (admitted.current === null && events.length > 0)
    admitted.current = new Set(events.map((event) => event.id));
  const waiting = events.filter((event) => admitted.current && !admitted.current.has(event.id));
  const admit = () => {
    admitted.current = new Set(events.map((event) => event.id));
    bump((n) => n + 1);
  };
  useEffect(() => {
    if (live && waiting.length > 0) admit();
  });
  const shown = events
    .filter((event) => !admitted.current || admitted.current.has(event.id))
    .slice(0, limit);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-7 pb-4">
        {pending > 0 ? (
          <StateChip tone="pending" shape="dashed">
            <Num>{pending}</Num> not in the feed yet — the money has already moved
          </StateChip>
        ) : (
          <StateChip tone="filled" shape="outline">
            Up to date
          </StateChip>
        )}
        {waiting.length > 0 && !live && (
          <Button size="sm" variant="brand" onClick={admit}>
            Show <Num>{waiting.length}</Num> new
          </Button>
        )}
        <label className="ml-auto flex items-center gap-4 text-sm text-ink-2">
          Add new rows as they arrive
          <Switch
            checked={live}
            onCheckedChange={setLive}
            aria-label="Add new rows as they arrive"
          />
        </label>
      </div>
      <ScrollArea className="flex-1" horizontal>
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              <th className={th}>Money moved (UTC)</th>
              <th className={th}>What happened</th>
              <th className={cn(th, right)}>Amount USD</th>
              <th
                className={cn(th, right)}
                title="How long after the money moved this event reached the feed"
              >
                Delivered
              </th>
              {!compact && (
                <th className={th}>
                  <span className="sr-only">Details</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {shown.map((event) => {
              const d = describeEvent(event);
              const expanded = open === event.id;
              return (
                <Fragment key={event.id}>
                  <tr className={row}>
                    <td className={cn(td, 'num')}>{showDateTime(event.occurredAt)}</td>
                    <td className={cn(td, 'max-w-240 truncate')} title={d.title}>
                      {d.title}
                    </td>
                    <td
                      className={cn(
                        td,
                        'num font-medium',
                        right,
                        d.direction > 0 ? 'text-success' : 'text-ink',
                      )}
                    >
                      {d.direction > 0 ? '+' : d.direction < 0 ? '−' : ''}
                      {showCash(event.amount)}
                    </td>
                    <td className={cn(td, 'num text-ink-3', right)}>
                      {showLag(event.occurredAt, event.publishedAt)}
                    </td>
                    {!compact && (
                      <td className={cn(td, right)}>
                        <LinkButton
                          onClick={() => setOpen(expanded ? null : event.id)}
                          aria-expanded={expanded}
                        >
                          {expanded ? 'Hide ledger' : 'Ledger'}
                        </LinkButton>
                        {event.reference && (
                          <LinkButton
                            className="ml-5"
                            onClick={() => receipt.open(event.reference as string)}
                          >
                            Receipt
                          </LinkButton>
                        )}
                      </td>
                    )}
                  </tr>
                  {expanded && (
                    <tr className="border-b border-line bg-well">
                      <td colSpan={5} className="px-7 py-5">
                        <div className="max-w-300">
                          <Ledger entries={event.entries} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {shown.length === 0 && (
              <tr className={row}>
                <td colSpan={5} className={cn(td, 'text-ink-3')}>
                  No money has moved yet. Trades, deposits, withdrawals and transfers appear here,
                  each a moment after it happens.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

export function HistoryPage() {
  const me = useMe();
  const activity = useActivity();
  const fills = useFills();
  const orders = useOrders();
  const [params, setParams] = useSearchParams();
  const receipt = useReceipt();
  const tab = params.get('tab') ?? 'activity';
  if (me.isPending) return <p className="p-10 text-ink-3">Loading your history…</p>;
  if (!me.data) return <GuestEntry page="history" />;
  const stale = (query: Parameters<typeof freshness>[0]) => {
    const f = freshness(query);
    return f.stale ? f.asOf : null;
  };
  const fillRows = fills.data?.fills ?? [];
  const orderRows = orders.data?.orders ?? [];
  const events = activity.data?.events ?? [];
  const exportButton = (onClick: () => void, disabled: boolean) => (
    <Button size="sm" onClick={onClick} disabled={disabled}>
      Download CSV
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 px-4 py-5 md:px-10 md:py-7">
      <Tabs
        value={tab}
        onValueChange={(next) => setParams({ tab: next }, { replace: true })}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="flex-none">
          <TabsTrigger value="activity">
            Activity
            {(activity.data?.pending ?? 0) > 0 && (
              <Num className="ml-3 rounded-tag border border-dashed border-you px-2 text-xs text-you">
                {activity.data?.pending} waiting
              </Num>
            )}
          </TabsTrigger>
          <TabsTrigger value="trades">
            Trades <Num className="ml-2 text-xs text-ink-3">{fillRows.length}</Num>
          </TabsTrigger>
          <TabsTrigger value="orders">
            Orders <Num className="ml-2 text-xs text-ink-3">{orderRows.length}</Num>
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="activity"
          className="mt-6 flex min-h-120 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <Panel
            title="Every movement of your cash"
            staleSince={stale(activity)}
            className="flex-1"
            actions={exportButton(
              () =>
                downloadCsv(
                  'daftar-activity.csv',
                  [
                    'id',
                    'type',
                    'occurredAt',
                    'publishedAt',
                    'amount',
                    'symbol',
                    'side',
                    'liquidity',
                    'price',
                    'quantity',
                    'counterparty',
                    'reference',
                  ],
                  events.map((e) => [
                    e.id,
                    e.type,
                    e.occurredAt,
                    e.publishedAt,
                    e.amount,
                    e.symbol,
                    e.side,
                    e.liquidity,
                    e.price,
                    e.quantity,
                    e.counterparty,
                    e.reference,
                  ]),
                ),
              events.length === 0,
            )}
          >
            <ActivityFeed events={events} pending={activity.data?.pending ?? 0} />
          </Panel>
        </TabsContent>

        <TabsContent
          value="trades"
          className="mt-6 flex min-h-120 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <Panel
            title="Your trades"
            aside={
              <span className="text-sm text-ink-3">every fill, from either side of the book</span>
            }
            staleSince={stale(fills)}
            className="flex-1"
            actions={exportButton(
              () =>
                downloadCsv(
                  'daftar-trades.csv',
                  [
                    'tradeId',
                    'createdAt',
                    'side',
                    'liquidity',
                    'price',
                    'quantity',
                    'notional',
                    'counterparty',
                    'clientOrderId',
                  ],
                  fillRows.map((f) => [
                    f.tradeId,
                    f.createdAt,
                    f.side,
                    f.liquidity,
                    f.price,
                    f.quantity,
                    f.notional,
                    f.counterparty,
                    f.clientOrderId,
                  ]),
                ),
              fillRows.length === 0,
            )}
          >
            <ScrollArea className="flex-1" horizontal>
              <table className="w-full border-collapse">
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th className={th}>Time (UTC)</th>
                    <th className={th}>Side</th>
                    <th className={th}>Role</th>
                    <th className={cn(th, right)}>Price</th>
                    <th className={cn(th, right)}>Quantity</th>
                    <th className={cn(th, right)}>Value USD</th>
                    <th className={th}>With</th>
                    <th className={th}>
                      <span className="sr-only">Receipt</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {fillRows.map((fill) => (
                    <tr key={`${fill.tradeId}:${fill.side}`} className={row}>
                      <td className={cn(td, 'num')}>{showDateTime(fill.createdAt)}</td>
                      <td className={td}>
                        <SideTag side={fill.side} />
                      </td>
                      <td
                        className={td}
                        title={
                          fill.liquidity === 'maker'
                            ? 'Your order was waiting in the book and someone took it'
                            : 'You took an order that was waiting in the book'
                        }
                      >
                        {fill.liquidity}
                      </td>
                      <td className={cn(td, 'num', right)}>{showCash(fill.price)}</td>
                      <td className={cn(td, 'num', right)}>{showQty(fill.quantity)}</td>
                      <td className={cn(td, 'num', right)}>{showCash(fill.notional)}</td>
                      <td
                        className={cn(td, 'max-w-90 truncate')}
                        title={fill.counterparty ?? undefined}
                      >
                        {fill.counterparty ?? '—'}
                      </td>
                      <td className={cn(td, right)}>
                        <LinkButton onClick={() => receipt.open(fill.clientOrderId)}>
                          Receipt
                        </LinkButton>
                      </td>
                    </tr>
                  ))}
                  {fillRows.length === 0 && (
                    <tr className={row}>
                      <td colSpan={8} className={cn(td, 'text-ink-3')}>
                        No trades yet. Each fill of one of your orders is one row here.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
          </Panel>
        </TabsContent>

        <TabsContent
          value="orders"
          className="mt-6 flex min-h-120 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <Panel
            title="Your orders"
            aside={<span className="text-sm text-ink-3">the latest hundred, in any state</span>}
            staleSince={stale(orders)}
            className="flex-1"
            actions={exportButton(
              () =>
                downloadCsv(
                  'daftar-orders.csv',
                  [
                    'clientOrderId',
                    'createdAt',
                    'updatedAt',
                    'side',
                    'type',
                    'limitPrice',
                    'quantity',
                    'filledQuantity',
                    'status',
                    'cancelReason',
                  ],
                  orderRows.map((o) => [
                    o.clientOrderId,
                    o.createdAt,
                    o.updatedAt,
                    o.side,
                    o.type,
                    o.limitPrice,
                    o.quantity,
                    o.filledQuantity,
                    o.status,
                    o.cancelReason,
                  ]),
                ),
              orderRows.length === 0,
            )}
          >
            <ScrollArea className="flex-1" horizontal>
              <table className="w-full border-collapse">
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th className={th}>Placed (UTC)</th>
                    <th className={th}>Side</th>
                    <th className={th}>Type</th>
                    <th className={cn(th, right)}>Price</th>
                    <th className={cn(th, right)}>Quantity</th>
                    <th className={cn(th, right)}>Filled</th>
                    <th className={th}>Status</th>
                    <th className={th}>
                      <span className="sr-only">Receipt</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {orderRows.map((order) => {
                    const status = describeStatus(order);
                    return (
                      <tr key={order.clientOrderId} className={row}>
                        <td className={cn(td, 'num')}>{showDateTime(order.createdAt)}</td>
                        <td className={td}>
                          <SideTag side={order.side} />
                        </td>
                        <td className={td}>{order.type}</td>
                        <td className={cn(td, 'num', right)}>
                          {order.limitPrice ? (
                            showCash(order.limitPrice)
                          ) : (
                            <span className="font-ui text-ink-3">market</span>
                          )}
                        </td>
                        <td
                          className={cn(
                            td,
                            'num',
                            right,
                            status.tone === 'cancelled' && 'text-ink-3',
                          )}
                        >
                          {showQty(order.quantity)}
                        </td>
                        <td className={cn(td, 'num', right)}>{showQty(order.filledQuantity)}</td>
                        <td className={td}>
                          <StateChip tone={status.tone}>{status.word}</StateChip>
                          {status.reason && (
                            <span className="ml-3 text-sm text-ink-3">{status.reason}</span>
                          )}
                        </td>
                        <td className={cn(td, right)}>
                          <LinkButton onClick={() => receipt.open(order.clientOrderId)}>
                            Receipt
                          </LinkButton>
                        </td>
                      </tr>
                    );
                  })}
                  {orderRows.length === 0 && (
                    <tr className={row}>
                      <td colSpan={8} className={cn(td, 'text-ink-3')}>
                        No orders yet. Every order you place is listed here, whatever became of it.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}
