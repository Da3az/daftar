import { clockTime, trimQuantity, type TapeTrade } from '@/lib/exchange';
import { Card, CardHeader, Empty } from '@/components/ui/primitives';

/**
 * Recent trades, newest first.
 *
 * Coloured by the aggressor's side: a trade printed green was a buyer taking an
 * offer, red a seller hitting a bid. That is the convention a tape is read by —
 * it says which way the pressure was, not whether the price went up.
 */
export function Tape({ trades }: { trades: TapeTrade[] | undefined }): React.JSX.Element {
  return (
    <Card>
      <CardHeader title="Trades" hint="Coloured by who crossed the spread." />

      <div className="text-ink-500 grid grid-cols-3 px-3 pt-2 text-[11px]">
        <span>Price</span>
        <span className="text-right">Quantity</span>
        <span className="text-right">Time (UTC)</span>
      </div>

      {trades === undefined || trades.length === 0 ? (
        <Empty>No trades yet.</Empty>
      ) : (
        <ol className="max-h-80 overflow-y-auto py-1">
          {trades.map((trade) => (
            <li key={trade.id} className="grid grid-cols-3 px-3 py-[3px] text-xs">
              <span className={`num ${trade.takerSide === 'buy' ? 'text-credit' : 'text-debit'}`}>
                {trade.price}
              </span>
              <span className="num text-ink-200 text-right">{trimQuantity(trade.quantity)}</span>
              <span className="num text-ink-500 text-right">{clockTime(trade.createdAt)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
