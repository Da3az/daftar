import { CASH_SCALE, QUANTITY_SCALE, formatCash, fromMinor, toMinor } from '@/lib/money';
import { percentChange, trimQuantity, type BookLevel, type MarketSnapshot } from '@/lib/exchange';
import { Card, CardHeader, Empty } from '@/components/ui/primitives';

/**
 * The order book: offers above, bids below, the spread between them.
 *
 * Each row carries a depth bar whose width is the level's quantity relative to
 * the largest level shown. That ratio is the one place a quantity becomes a
 * `number` — it sets a CSS width and is never displayed or sent anywhere.
 */
export function OrderBook({
  snapshot,
  onPickPrice,
}: {
  snapshot: MarketSnapshot | undefined;
  onPickPrice: (price: string) => void;
}): React.JSX.Element {
  const bids = snapshot?.book.bids ?? [];
  const asks = snapshot?.book.asks ?? [];

  const largest = [...bids, ...asks].reduce((max, level) => {
    const quantity = toMinor(level.quantity, QUANTITY_SCALE) ?? 0n;
    return quantity > max ? quantity : max;
  }, 0n);

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;

  return (
    <Card>
      <CardHeader title="Order book" hint="Click a price to use it." />

      <div className="text-ink-500 grid grid-cols-2 px-3 pt-2 text-[11px]">
        <span>Price (USD)</span>
        <span className="text-right">Quantity</span>
      </div>

      {bids.length === 0 && asks.length === 0 ? (
        <Empty>The book is empty. Are the bots running?</Empty>
      ) : (
        <div className="py-1">
          {/* Offers are best-first from the API; shown worst-first so the best
              offer sits directly above the spread, next to the best bid. */}
          {[...asks].reverse().map((level) => (
            <Row
              key={`ask-${level.price}`}
              level={level}
              side="sell"
              largest={largest}
              onPick={onPickPrice}
            />
          ))}

          <div className="border-ink-800 text-ink-400 my-1 flex items-baseline justify-between border-y px-3 py-1.5 text-xs">
            <span>Spread</span>
            <span className="num">
              {spreadOf(bestBid, bestAsk) ?? '—'}
              {bestBid !== null && bestAsk !== null && (
                <span className="text-ink-500 ml-2">
                  {percentChange(bestBid, bestAsk)?.replace('+', '') ?? ''}
                </span>
              )}
            </span>
          </div>

          {bids.map((level) => (
            <Row
              key={`bid-${level.price}`}
              level={level}
              side="buy"
              largest={largest}
              onPick={onPickPrice}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function spreadOf(bestBid: string | null, bestAsk: string | null): string | null {
  if (bestBid === null || bestAsk === null) return null;
  const bid = toMinor(bestBid, CASH_SCALE);
  const ask = toMinor(bestAsk, CASH_SCALE);
  if (bid === null || ask === null) return null;
  return formatCash(fromMinor(ask - bid, CASH_SCALE));
}

function Row({
  level,
  side,
  largest,
  onPick,
}: {
  level: BookLevel;
  side: 'buy' | 'sell';
  largest: bigint;
  onPick: (price: string) => void;
}): React.JSX.Element {
  const quantity = toMinor(level.quantity, QUANTITY_SCALE) ?? 0n;
  // Per-mille as an integer, then to a CSS percentage. Display geometry only.
  const width = largest > 0n ? Number((quantity * 1000n) / largest) / 10 : 0;

  return (
    <button
      type="button"
      onClick={() => onPick(level.price)}
      className="hover:bg-ink-800/60 relative grid w-full grid-cols-2 px-3 py-[3px] text-left text-xs"
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 right-0 ${side === 'buy' ? 'bg-credit/10' : 'bg-debit/10'}`}
        style={{ width: `${String(width)}%` }}
      />
      <span className={`num relative ${side === 'buy' ? 'text-credit' : 'text-debit'}`}>
        {level.price}
      </span>
      <span className="num text-ink-200 relative text-right">{trimQuantity(level.quantity)}</span>
    </button>
  );
}
