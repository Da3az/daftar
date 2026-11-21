import { freshness, useFills, useMarket, useMe } from '@/api/queries';
import { useState } from 'react';
import { Button, Callout } from '@/components/bits';
import { Sheet, SheetContent, SheetDescription } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DESKTOP, TABLET_UP, useMedia } from '@/lib/useMedia';
import { ChartPanel } from './ChartPanel';
import { MarketStrip } from './MarketStrip';
import { OpenOrders } from './OpenOrders';
import { OrderBook } from './OrderBook';
import { Tape } from './Tape';
import { Ticket } from './Ticket';
import { useTicket } from './ticketStore';
import { YourMoney } from './YourMoney';

/** The busiest screen. Public: market data renders for everyone; the session panels appear once there is one. */
export function TradePage() {
  const market = useMarket();
  const me = useMe();
  const fills = useFills();
  const desktop = useMedia(DESKTOP);
  const tablet = useMedia(TABLET_UP);
  const marketFresh = freshness(market);
  const meFresh = freshness(me);
  const snapshot = market.data;
  const marketStale = marketFresh.stale ? marketFresh.asOf : null;
  const meStale = meFresh.stale ? meFresh.asOf : null;
  const session = me.data ?? null;
  const [sheetOpen, setSheetOpen] = useState(false);
  const { setSide } = useTicket();

  const strip = (
    <>
      <MarketStrip snapshot={snapshot} />
      {market.isError && marketFresh.empty && (
        <Callout tone="warning" title="Market data is unavailable" role="alert">
          Nothing has loaded yet. Retrying every second — the page will fill in as soon as the
          server answers.
        </Callout>
      )}
    </>
  );
  const chart = (
    <ChartPanel
      lastPrice={snapshot?.market.lastPrice}
      openOrders={session?.openOrders}
      fills={fills.data?.fills}
      className="min-h-150 xl:min-h-0 xl:flex-1"
    />
  );
  const book = (
    <OrderBook
      snapshot={snapshot}
      openOrders={session?.openOrders}
      staleSince={marketStale}
      className="min-h-0 xl:flex-1"
    />
  );
  const tape = (
    <Tape
      snapshot={snapshot}
      staleSince={marketStale}
      className="max-h-240 min-h-0 xl:max-h-none xl:w-159 xl:flex-none"
    />
  );
  const ticket = (
    <Ticket snapshot={snapshot} me={me.isPending ? undefined : session} className="flex-none" />
  );
  const money = session ? (
    <YourMoney
      me={session}
      lastPrice={snapshot?.market.lastPrice}
      asOf={meFresh.asOf}
      staleSince={meStale}
      className="flex-none"
    />
  ) : null;
  const orders = session ? (
    <OpenOrders
      orders={session.openOrders}
      staleSince={meStale}
      className="min-h-80 xl:min-h-0 xl:flex-1"
    />
  ) : null;

  if (desktop) {
    return (
      <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_var(--rail-width)] gap-7 px-10 py-7">
        <div className="flex min-h-0 flex-col gap-7">
          {strip}
          {chart}
          <div className="flex h-170 min-h-0 flex-none gap-7">
            {book}
            {tape}
          </div>
        </div>
        <div className="flex min-h-0 flex-col gap-7 overflow-y-auto">
          {ticket}
          {money}
          {orders}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6 px-4 py-5 md:px-7">
      {strip}
      {chart}
      <div className="grid gap-6 md:grid-cols-2">
        {tablet && ticket}
        <div className="flex flex-col gap-6">
          {money}
          {orders}
          {tablet && !session && tape}
        </div>
      </div>
      <Tabs defaultValue="book">
        <TabsList className="px-2">
          <TabsTrigger value="book">Order book</TabsTrigger>
          <TabsTrigger value="tape">Latest trades</TabsTrigger>
        </TabsList>
        <TabsContent value="book" className="mt-4">
          {book}
        </TabsContent>
        <TabsContent value="tape" className="mt-4">
          {tape}
        </TabsContent>
      </Tabs>
      {!tablet && (
        <>
          <div aria-hidden className="h-24" />
          <div className="fixed inset-x-0 bottom-0 z-20 flex gap-4 border-t border-line-strong bg-surface p-4">
            <Button
              variant="buy"
              className="flex-1 font-display text-lg font-semibold"
              onClick={() => {
                setSide('buy');
                setSheetOpen(true);
              }}
            >
              {session ? '▲ Buy' : 'Enter as guest'}
            </Button>
            <Button
              variant="sell"
              className="flex-1 font-display text-lg font-semibold"
              onClick={() => {
                setSide('sell');
                setSheetOpen(true);
              }}
            >
              ▼ Sell
            </Button>
          </div>
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent side="bottom" title="Place an order">
              <SheetDescription className="sr-only">
                Choose a side, a price and a quantity.
              </SheetDescription>
              <Ticket snapshot={snapshot} me={me.isPending ? undefined : session} plain />
            </SheetContent>
          </Sheet>
        </>
      )}
    </div>
  );
}
