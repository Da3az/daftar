import { useSearchParams } from 'react-router';
import { useActivity, useFills, useOrders, useWithdrawals } from '@/api/queries';
import { Callout, CopyButton, Num, SideTag } from '@/components/bits';
import { Sheet, SheetContent, SheetDescription } from '@/components/ui/sheet';
import { showCash, showQty } from '@/lib/money';
import { QUOTE } from '@/lib/rules';
import { showDateTime, showExact, showLag } from '@/lib/time';
import { describeEvent, describeStatus } from './describe';
import { Ledger } from './Ledger';

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-8 border-b border-line py-2">
      <dt className="text-sm text-ink-3">{label}</dt>
      <dd className="min-w-0 text-right text-sm">{children}</dd>
    </div>
  );
}

/** Hook for opening a receipt: it lives in the URL (?receipt=<reference>), so it can be linked and survives reload. */
export function useReceipt(): {
  open: (reference: string) => void;
  reference: string | null;
  close: () => void;
} {
  const [params, setParams] = useSearchParams();
  const change = (reference: string | null) => {
    const next = new URLSearchParams(params);
    if (reference) next.set('receipt', reference);
    else next.delete('receipt');
    setParams(next, { replace: reference === null });
  };
  return {
    reference: params.get('receipt'),
    open: (reference) => change(reference),
    close: () => change(null),
  };
}

/** Everything known about one order or one cash movement, by the id the client chose for it. */
export function ReceiptSheet() {
  const { reference, close } = useReceipt();
  const activity = useActivity();
  const fills = useFills();
  const orders = useOrders();
  const events = (activity.data?.events ?? []).filter((event) => event.reference === reference);
  const ownFills = (fills.data?.fills ?? []).filter((fill) => fill.clientOrderId === reference);
  const order = (orders.data?.orders ?? []).find((item) => item.clientOrderId === reference);
  const withdrawals = useWithdrawals();
  const withdrawal = (withdrawals.data?.withdrawals ?? []).find((w) => w.clientId === reference);
  const first = events[0];
  const status = order ? describeStatus(order) : null;
  const loading = activity.isPending || fills.isPending || orders.isPending;
  const nothing = !loading && !first && !order && ownFills.length === 0;
  const title = order
    ? `Order: ${order.side} ${showQty(order.quantity)} ${order.symbol}`
    : first
      ? describeEvent(first).title
      : 'Receipt';

  return (
    <Sheet
      open={reference !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent title={title}>
        <SheetDescription className="sr-only">
          Details and ledger lines for this order or cash movement.
        </SheetDescription>
        {reference && (
          <div className="flex flex-col gap-7 p-7">
            <dl>
              <Line label="Reference">
                <span className="flex items-center justify-end gap-3">
                  <Num className="truncate">{reference}</Num>
                  <CopyButton text={reference} className="border border-line-strong" />
                </span>
              </Line>
              {order && (
                <>
                  <Line label="Side and type">
                    <SideTag side={order.side} /> {order.type}
                  </Line>
                  <Line label="Price">
                    <Num>{order.limitPrice ? showCash(order.limitPrice) : 'market'}</Num>
                  </Line>
                  <Line label="Quantity">
                    <Num>{showQty(order.quantity, 8)}</Num>
                  </Line>
                  <Line label="Filled">
                    <Num>{showQty(order.filledQuantity, 8)}</Num>
                  </Line>
                  <Line label="Status">
                    {status?.word}
                    {status?.reason ? ` — ${status.reason}` : ''}
                  </Line>
                  <Line label="Placed">
                    <Num>{showExact(order.createdAt)}</Num>
                  </Line>
                </>
              )}
              {!order && first && (
                <>
                  <Line label="Amount">
                    <Num>{showCash(first.amount)}</Num> {QUOTE}
                  </Line>
                  <Line label="Money moved">
                    <Num>{showExact(first.occurredAt)}</Num>
                  </Line>
                  <Line label="Reached your feed">
                    <Num>{showExact(first.publishedAt)}</Num>{' '}
                    <Num className="text-ink-3">
                      ({showLag(first.occurredAt, first.publishedAt)})
                    </Num>
                  </Line>
                </>
              )}
            </dl>

            {ownFills.length > 0 && (
              <section>
                <h3 className="font-display text-lg font-semibold">Fills</h3>
                <table className="mt-2 w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs text-ink-3">
                      <th className="py-1 text-left font-medium">Time UTC</th>
                      <th className="py-1 text-left font-medium">Role</th>
                      <th className="py-1 text-right font-medium">Price</th>
                      <th className="py-1 text-right font-medium">Quantity</th>
                      <th className="py-1 text-right font-medium">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ownFills.map((fill) => (
                      <tr key={fill.tradeId} className="border-b border-line">
                        <td className="num py-2">{showExact(fill.createdAt).slice(11, 23)}</td>
                        <td className="py-2">{fill.liquidity}</td>
                        <td className="num py-2 text-right">{showCash(fill.price)}</td>
                        <td className="num py-2 text-right">{showQty(fill.quantity)}</td>
                        <td className="num py-2 text-right">{showCash(fill.notional)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {events.length > 0 && (
              <section>
                <h3 className="font-display text-lg font-semibold">Ledger</h3>
                <p className="mb-3 text-sm text-ink-2">
                  Each movement is one balanced transaction: whatever leaves one account arrives in
                  another.
                </p>
                <div className="flex flex-col gap-7">
                  {events.map((event) => (
                    <div key={event.id}>
                      {events.length > 1 && (
                        <p className="mb-1 text-sm font-semibold">{describeEvent(event).title}</p>
                      )}
                      <Ledger entries={event.entries} />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {withdrawal && (
              <section>
                <h3 className="font-display text-lg font-semibold">How this withdrawal went</h3>
                <p className="mb-3 text-sm text-ink-2">
                  Every state change, as the database recorded it.
                </p>
                <ol className="flex flex-col gap-1 text-sm">
                  {withdrawal.history.map((t, i) => (
                    <li key={i} className="flex gap-4">
                      <span className="num w-44 flex-none text-ink-3">{showDateTime(t.at)}</span>
                      <span className="text-ink-2">
                        {t.from ? `${t.from} → ` : ''}
                        <b className="font-semibold text-ink">{t.to}</b>
                        {t.reason ? ` — ${t.reason}` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {!loading &&
              events.length === 0 &&
              (order || ownFills.length > 0) &&
              ownFills.length > 0 && (
                <Callout tone="info" title="Not in your feed yet">
                  The money has moved, and the events describing it are still being delivered. The
                  ledger lines appear here once they arrive.
                </Callout>
              )}
            {nothing && (
              <Callout tone="info" title="Not in your feed yet">
                Nothing with this reference has been delivered to this page so far. If you just made
                the movement, its event is on its way — this fills in by itself.
              </Callout>
            )}
            {loading && <p className="text-sm text-ink-3">Loading…</p>}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
