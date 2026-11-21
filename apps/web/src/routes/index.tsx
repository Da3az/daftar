import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMarketSnapshot, useMe } from '@/lib/exchange';
import { ExchangeChart } from '@/components/exchange/ExchangeChart';
import { MarketHeader } from '@/components/exchange/MarketHeader';
import { OpenOrders } from '@/components/exchange/OpenOrders';
import { OrderBook } from '@/components/exchange/OrderBook';
import { OrderForm } from '@/components/exchange/OrderForm';
import { Tape } from '@/components/exchange/Tape';
import { ErrorNote } from '@/components/ui/primitives';

export const Route = createFileRoute('/')({ component: TradeScreen });

/**
 * The trading screen: one market, live.
 *
 * Market data is public and renders for everyone; the order ticket is the only
 * part that needs a session, and it turns into "enter as guest" without one.
 * A visitor can watch the book move before deciding to touch anything.
 */
function TradeScreen(): React.JSX.Element {
  const snapshot = useMarketSnapshot();
  const me = useMe();

  /*
   * An object, not a bare string, so clicking the same price twice is still a
   * change of identity — otherwise re-picking a price after editing the field
   * by hand would do nothing.
   */
  const [pickedPrice, setPickedPrice] = useState<{ price: string } | null>(null);

  return (
    <div className="space-y-6">
      <MarketHeader snapshot={snapshot.data} />

      {snapshot.isError && (
        <ErrorNote>
          Market data is unavailable — {snapshot.error.message}. Retrying every second.
        </ErrorNote>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem_20rem]">
        <div className="min-w-0 space-y-6">
          <ExchangeChart symbol={snapshot.data?.market.symbol ?? 'DFT'} />
          {me.data && <OpenOrders orders={me.data.openOrders} />}
        </div>

        <div className="space-y-6">
          <OrderBook snapshot={snapshot.data} onPickPrice={(price) => setPickedPrice({ price })} />
        </div>

        <div className="space-y-6">
          <OrderForm snapshot={snapshot.data} me={me.data} pickedPrice={pickedPrice} />
          <Tape trades={snapshot.data?.tape} />
        </div>
      </div>
    </div>
  );
}
