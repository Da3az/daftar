import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useApi } from '@/api/context';
import { useRefreshSession } from '@/api/queries';
import type { ExchangeOrder } from '@/api/types';
import { Button, LinkButton, Num, SideTag } from '@/components/bits';
import { Panel, td } from '@/components/Panel';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/cn';
import { parseQty, ratioForBar, showCash, showQty } from '@/lib/money';
import { MAX_OPEN_ORDERS } from '@/lib/rules';
import { describeCancelError, type Refusal } from '../errors';

/** The guest's waiting orders, each cancellable in place. A cancel that lost a race says so on its own row. */
export function OpenOrders({
  orders,
  staleSince,
  className,
}: {
  orders: ExchangeOrder[];
  staleSince: number | null;
  className?: string;
}) {
  const api = useApi();
  const refresh = useRefreshSession();
  const [notes, setNotes] = useState<Record<string, Refusal>>({});
  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelOrder(id),
    onSuccess: (_, id) => {
      setNotes(({ [id]: _gone, ...rest }) => rest);
      refresh();
    },
    onError: (error, id) => {
      setNotes((current) => ({ ...current, [id]: describeCancelError(error) }));
      refresh();
    },
  });
  const cancelAll = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(
        orders.map((order) => api.cancelOrder(order.clientOrderId)),
      );
      return {
        cancelled: results.filter((r) => r.status === 'fulfilled').length,
        missed: results.filter((r) => r.status === 'rejected').length,
      };
    },
    onSuccess: ({ cancelled, missed }) => {
      toast.success(`${cancelled} ${cancelled === 1 ? 'order' : 'orders'} cancelled`, {
        description: missed
          ? `${missed} had already filled or been cancelled.`
          : 'Their cash and coins are free again.',
      });
      refresh();
    },
  });
  /** An order this tab has a note about but the list no longer has: only its id is known. */
  const listed: (Partial<ExchangeOrder> & { clientOrderId: string })[] = [
    ...orders,
    ...Object.keys(notes)
      .filter((id) => !orders.some((order) => order.clientOrderId === id))
      .map((id) => ({ clientOrderId: id })),
  ];
  return (
    <Panel
      title="Open orders"
      aside={
        <span className="text-sm text-ink-3">
          <Num>{orders.length}</Num> of {MAX_OPEN_ORDERS}
        </span>
      }
      staleSince={staleSince}
      className={className}
      actions={
        <>
          <Link
            to="/history"
            className="rounded-tag text-sm text-info underline underline-offset-4"
          >
            All orders
          </Link>
          {orders.length > 1 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <LinkButton tone="danger">Cancel all</LinkButton>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogTitle className="font-display text-xl font-semibold">
                  Cancel all {orders.length} open orders?
                </AlertDialogTitle>
                <AlertDialogDescription className="mt-3 text-ink-2">
                  They leave the book and what they set aside is freed. Any part that has already
                  filled stays filled.
                </AlertDialogDescription>
                <div className="mt-8 flex justify-end gap-4">
                  <AlertDialogCancel asChild>
                    <Button>Keep them</Button>
                  </AlertDialogCancel>
                  <AlertDialogAction asChild>
                    <Button variant="danger-solid" onClick={() => cancelAll.mutate()}>
                      Cancel all {orders.length}
                    </Button>
                  </AlertDialogAction>
                </div>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </>
      }
    >
      <ScrollArea className="flex-1">
        <table className="w-full table-auto border-collapse">
          <thead className="sr-only">
            <tr>
              <th>Side</th>
              <th>Quantity and price</th>
              <th>Progress</th>
              <th>Cancel</th>
            </tr>
          </thead>
          <tbody>
            {listed.map((order) => {
              const note = notes[order.clientOrderId];
              const quantity = parseQty(order.quantity);
              const filled = parseQty(order.filledQuantity);
              const busy = cancel.isPending && cancel.variables === order.clientOrderId;
              if (note && !orders.some((o) => o.clientOrderId === order.clientOrderId)) {
                return (
                  <tr key={order.clientOrderId} className="h-(--row-table)">
                    <td colSpan={3} className={cn(td, 'whitespace-normal py-2 text-info')}>
                      <b className="font-semibold">{note.title}.</b> {note.detail}
                    </td>
                    <td className={cn(td, 'text-right')}>
                      <LinkButton
                        tone="ink"
                        onClick={() =>
                          setNotes(({ [order.clientOrderId]: _gone, ...rest }) => rest)
                        }
                      >
                        Dismiss
                      </LinkButton>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={order.clientOrderId} className="h-(--row-table)">
                  <td className={cn(td, 'pr-0')}>
                    {order.side ? <SideTag side={order.side} /> : '—'}
                  </td>
                  <td className={cn(td, 'num px-3 text-right')}>
                    {showQty(order.quantity)} <span className="font-ui text-ink-3">at</span>{' '}
                    {order.limitPrice ? showCash(order.limitPrice) : 'market'}
                  </td>
                  <td className={cn(td, 'px-3 text-ink-3')}>
                    {note ? (
                      <span className="whitespace-normal text-warning">{note.title}</span>
                    ) : filled !== null && filled > 0n && quantity ? (
                      <span className="inline-flex items-center gap-3 text-notice-ink">
                        <Num>{showQty(order.filledQuantity)}</Num> filled
                        <span
                          className="inline-block h-3 w-10 overflow-hidden rounded-bar bg-line"
                          aria-hidden
                        >
                          <span
                            className="block h-full bg-notice"
                            style={{ width: `${ratioForBar(filled, quantity) * 100}%` }}
                          />
                        </span>
                      </span>
                    ) : (
                      'waiting'
                    )}
                  </td>
                  <td className={cn(td, 'pl-0 text-right')}>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      onClick={() => cancel.mutate(order.clientOrderId)}
                      aria-label={`Cancel ${order.side} ${showQty(order.quantity)} at ${showCash(order.limitPrice)}`}
                    >
                      {busy ? 'Cancelling' : 'Cancel'}
                    </Button>
                  </td>
                </tr>
              );
            })}
            {listed.length === 0 && (
              <tr className="h-(--row-table)">
                <td colSpan={4} className={cn(td, 'text-ink-3')}>
                  No open orders. A limit order that does not fill straight away waits here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </ScrollArea>
    </Panel>
  );
}
