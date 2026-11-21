import { useRef } from 'react';
import type { MarketSnapshot } from '@/api/types';
import { SideTag } from '@/components/bits';
import { Panel, td, th } from '@/components/Panel';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/cn';
import { showCash, showQty } from '@/lib/money';
import { showTime } from '@/lib/time';

/** The last trades, newest first. A row that was not there on the previous poll flashes once. */
export function Tape({
  snapshot,
  staleSince,
  className,
}: {
  snapshot: MarketSnapshot | undefined;
  staleSince: number | null;
  className?: string;
}) {
  const trades = snapshot?.tape ?? [];
  const known = useRef<Set<string> | null>(null);
  const fresh = new Set(
    known.current
      ? trades.filter((trade) => !known.current?.has(trade.id)).map((trade) => trade.id)
      : [],
  );
  known.current = new Set(trades.map((trade) => trade.id));
  return (
    <Panel
      title="Latest trades"
      actions={<span className="text-sm text-ink-3">UTC</span>}
      staleSince={staleSince}
      className={className}
    >
      <ScrollArea className="flex-1">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-surface">
            <tr>
              <th className={th}>Time</th>
              <th className={th}>Taker</th>
              <th className={cn(th, 'text-right')}>Price</th>
              <th className={cn(th, 'text-right')}>Quantity</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => (
              <tr
                key={trade.id}
                className={cn('h-(--row-tape)', fresh.has(trade.id) && 'animate-flash')}
                style={{
                  ['--flash-color' as string]:
                    trade.takerSide === 'buy' ? 'var(--color-buy-wash)' : 'var(--color-sell-wash)',
                }}
              >
                <td className={cn(td, 'num')}>{showTime(trade.createdAt)}</td>
                <td className={td}>
                  {trade.takerSide === 'buy' || trade.takerSide === 'sell' ? (
                    <SideTag side={trade.takerSide} />
                  ) : (
                    '—'
                  )}
                </td>
                <td className={cn(td, 'num text-right')}>{showCash(trade.price)}</td>
                <td className={cn(td, 'num text-right')}>{showQty(trade.quantity)}</td>
              </tr>
            ))}
            {trades.length === 0 && (
              <tr className="h-(--row-tape)">
                <td colSpan={4} className={cn(td, 'text-ink-3')}>
                  {snapshot ? 'No trades yet.' : 'Waiting for the first snapshot…'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </ScrollArea>
    </Panel>
  );
}
