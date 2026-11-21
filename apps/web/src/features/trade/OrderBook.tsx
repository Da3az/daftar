import { Fragment, useMemo, useRef, useState } from 'react';
import type { BookLevel, ExchangeOrder, MarketSnapshot, Side } from '@/api/types';
import { Panel } from '@/components/Panel';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/cn';
import {
  formatUnits,
  notional,
  parseCash,
  parseQty,
  ratioForBar,
  showCash,
  showQty,
} from '@/lib/money';
import { QUOTE, SYMBOL } from '@/lib/rules';
import { DESKTOP, useMedia } from '@/lib/useMedia';
import { BookBasics } from './BookBasics';
import { spreadOf } from './ticketMath';
import { useTicket } from './ticketStore';

const LEVELS = 14;

interface Row {
  level: BookLevel;
  cumUnits: bigint;
  cumCents: bigint;
}

function accumulate(levels: BookLevel[]): Row[] {
  let cumUnits = 0n;
  let cumCents = 0n;
  return levels.slice(0, LEVELS).map((level) => {
    const qty = parseQty(level.quantity) ?? 0n;
    cumUnits += qty;
    cumCents += notional(parseCash(level.price) ?? 0n, qty);
    return { level, cumUnits, cumCents };
  });
}

/** Remaining quantity of the guest's own resting orders, by side and price. */
function ownByPrice(orders: ExchangeOrder[] | undefined): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (const order of orders ?? []) {
    if (order.status !== 'open' || !order.limitPrice) continue;
    const left = (parseQty(order.quantity) ?? 0n) - (parseQty(order.filledQuantity) ?? 0n);
    const key = `${order.side}:${order.limitPrice}`;
    map.set(key, (map.get(key) ?? 0n) + left);
  }
  return map;
}

/** Counts how often each price's quantity has changed, so only that cell flashes. */
function useChangeCounts(levels: BookLevel[]): Map<string, number> {
  const previous = useRef(new Map<string, string>());
  const counts = useRef(new Map<string, number>());
  const seen = new Map<string, string>();
  for (const level of levels) {
    seen.set(level.price, level.quantity);
    const before = previous.current.get(level.price);
    if (before !== undefined && before !== level.quantity)
      counts.current.set(level.price, (counts.current.get(level.price) ?? 0) + 1);
  }
  previous.current = seen;
  return counts.current;
}

interface SideProps {
  side: Side;
  rows: Row[];
  maxUnits: bigint;
  own: Map<string, bigint>;
  mirrored: boolean;
  /** Top-to-bottom order is reversed for asks in the stacked layout, so best prices meet in the middle. */
  reversed?: boolean;
  hovered: number | null;
  onHover: (index: number | null) => void;
}

function BookSide({ side, rows, maxUnits, own, mirrored, reversed, hovered, onHover }: SideProps) {
  const { takePrice } = useTicket();
  const changes = useChangeCounts(rows.map((row) => row.level));
  const slots = Array.from({ length: LEVELS }, (_, index) => ({ index, row: rows[index] }));
  if (reversed) slots.reverse();
  const tone = side === 'buy' ? 'text-buy' : 'text-sell';
  const bar = side === 'buy' ? 'bg-buy' : 'bg-sell';
  const cells = (row: Row | undefined) => {
    const mine = row ? own.get(`${side}:${row.level.price}`) : undefined;
    const price = (
      <span
        className={cn(
          'num w-32 flex-none font-semibold',
          tone,
          mirrored ? 'text-right' : 'text-left',
        )}
      >
        {row ? showCash(row.level.price) : ''}
      </span>
    );
    const quantity = (
      <span
        key={row ? `${row.level.price}:${changes.get(row.level.price) ?? 0}` : 'empty'}
        className={cn(
          'num flex min-w-0 flex-1 items-center gap-3 rounded-bar',
          mirrored ? 'justify-end' : 'justify-start',
          row && (changes.get(row.level.price) ?? 0) > 0 && 'animate-flash',
        )}
        style={{
          ['--flash-color' as string]:
            side === 'buy' ? 'var(--color-buy-wash)' : 'var(--color-sell-wash)',
        }}
      >
        {mine !== undefined && (
          <span className="rounded-pill bg-you-wash px-3 font-ui text-xs font-semibold text-you">
            you {showQty(mine)}
          </span>
        )}
        {row ? showQty(row.level.quantity) : ''}
      </span>
    );
    const total = (
      <span className={cn('num w-44 flex-none text-ink-2', mirrored ? 'text-right' : 'text-left')}>
        {row ? showQty(row.cumUnits) : ''}
      </span>
    );
    const orders = (
      <span className={cn('num w-18 flex-none text-ink-3', mirrored ? 'text-right' : 'text-left')}>
        {row ? row.level.orders : ''}
      </span>
    );
    const order = mirrored ? [orders, total, quantity, price] : [price, quantity, total, orders];
    return order.map((cell, index) => <Fragment key={index}>{cell}</Fragment>);
  };
  return (
    <div
      role="list"
      aria-label={side === 'buy' ? 'Bids, best first' : 'Asks, best first'}
      onMouseLeave={() => onHover(null)}
    >
      {rows.length === 0 && (
        <p className="px-7 py-3 text-sm text-ink-3">
          {side === 'buy' ? 'Nobody is bidding.' : 'Nobody is asking.'}
        </p>
      )}
      {slots.slice(rows.length === 0 ? 1 : 0).map(({ index, row }) => (
        <div role="listitem" key={index} className="relative h-(--row-book)">
          {row && (
            <span
              aria-hidden
              className={cn(
                'absolute inset-y-1 rounded-bar opacity-(--depth-opacity)',
                bar,
                mirrored ? 'right-0' : 'left-0',
              )}
              style={{ width: `${ratioForBar(row.cumUnits, maxUnits) * 100}%` }}
            />
          )}
          {row ? (
            <button
              type="button"
              onClick={() => takePrice(row.level.price)}
              onMouseEnter={() => onHover(index)}
              onFocus={() => onHover(index)}
              onBlur={() => onHover(null)}
              aria-label={`${side === 'buy' ? 'Bid' : 'Ask'} ${showCash(row.level.price)}, ${showQty(row.level.quantity)} coins in ${row.level.orders} orders. Use this price.`}
              className={cn(
                'relative flex size-full items-center gap-5 px-5 text-sm',
                hovered !== null && index <= hovered && 'bg-info-wash/60',
              )}
            >
              {cells(row)}
            </button>
          ) : (
            <div className="flex size-full items-center gap-5 px-5 text-sm" aria-hidden>
              {cells(undefined)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Heads({ mirrored }: { mirrored: boolean }) {
  const heads = [
    ['Price', 'w-32'],
    ['Quantity', 'flex-1'],
    ['Running total', 'w-44'],
    ['Orders', 'w-18'],
  ] as const;
  const ordered = mirrored ? [...heads].reverse() : heads;
  return (
    <div
      className="flex gap-5 border-b border-line px-5 py-2 text-xs font-medium text-ink-3"
      aria-hidden
    >
      {ordered.map(([label, width]) => (
        <span
          key={label}
          className={cn(
            'whitespace-nowrap',
            width,
            width !== 'flex-1' && 'flex-none',
            mirrored ? 'text-right' : 'text-left',
          )}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

function Middle({
  bids,
  asks,
  className,
}: {
  bids: BookLevel[];
  asks: BookLevel[];
  className?: string;
}) {
  const { middle, gap, gapPercent } = spreadOf(bids, asks);
  return (
    <p
      className={cn(
        'whitespace-nowrap rounded-field border border-line bg-well px-5 py-1 text-sm text-ink-2',
        className,
      )}
    >
      Middle <b className="num font-semibold text-ink">{middle ?? '—'}</b> · gap{' '}
      <b className="num font-semibold text-ink">{gap ?? '—'}</b>
      {gapPercent && (
        <>
          {' '}
          (<span className="num text-ink">{gapPercent}</span>)
        </>
      )}
      {!middle && <span className="ml-3 text-ink-3">one side is empty</span>}
    </p>
  );
}

/** What trading from the best price out to the hovered row would come to. Lives in a fixed strip: no jump, nothing covered. */
function Sweep({ side, rows, index }: { side: Side; rows: Row[]; index: number | null }) {
  const row = index === null ? undefined : rows[index];
  if (!row)
    return (
      <p className="truncate px-7 text-sm text-ink-3">
        Point at a row to see what trading down to it would come to. Click a price to use it.
      </p>
    );
  const average =
    row.cumUnits > 0n ? formatUnits((row.cumCents * 100_000_000n * 100n) / row.cumUnits, 4) : '—';
  return (
    <p className="truncate px-7 text-sm" role="status">
      {side === 'sell' ? 'Buying' : 'Selling'} every row to{' '}
      <b className="num">{showCash(row.level.price)}</b>:{' '}
      <b className="num">{showQty(row.cumUnits)}</b> {SYMBOL} for about{' '}
      <b className="num">{showCash(row.cumCents)}</b> {QUOTE}, averaging{' '}
      <b className="num">{average}</b>.
    </p>
  );
}

export function OrderBook({
  snapshot,
  openOrders,
  staleSince,
  className,
}: {
  snapshot: MarketSnapshot | undefined;
  openOrders: ExchangeOrder[] | undefined;
  staleSince: number | null;
  className?: string;
}) {
  const facing = useMedia(DESKTOP);
  const [hover, setHover] = useState<{ side: Side; index: number } | null>(null);
  const bids = snapshot?.book.bids ?? [];
  const asks = snapshot?.book.asks ?? [];
  const bidRows = useMemo(() => accumulate(bids), [bids]);
  const askRows = useMemo(() => accumulate(asks), [asks]);
  const own = useMemo(() => ownByPrice(openOrders), [openOrders]);
  const lastBid = bidRows[bidRows.length - 1]?.cumUnits ?? 0n;
  const lastAsk = askRows[askRows.length - 1]?.cumUnits ?? 0n;
  const maxUnits = lastBid > lastAsk ? lastBid : lastAsk;
  const sideProps = (side: Side) => ({
    side,
    own,
    maxUnits,
    rows: side === 'buy' ? bidRows : askRows,
    hovered: hover?.side === side ? hover.index : null,
    onHover: (index: number | null) => setHover(index === null ? null : { side, index }),
  });
  const banner = (side: Side) => (
    <div
      className={cn(
        'px-7 py-2 text-sm font-semibold',
        side === 'buy' ? 'bg-buy-wash text-buy' : 'bg-sell-wash text-sell',
        facing && side === 'sell' && 'text-right',
      )}
    >
      {side === 'buy' ? '▲ Buyers are bidding' : 'Sellers are asking ▼'}
    </div>
  );
  return (
    <Panel
      title="Order book"
      aside={<BookBasics />}
      actions={facing ? <Middle bids={bids} asks={asks} /> : undefined}
      staleSince={staleSince}
      className={className}
    >
      <ScrollArea className="flex-1">
        {facing ? (
          <div className="grid grid-cols-2">
            <div className="border-r border-line-strong">
              {banner('buy')}
              <Heads mirrored />
              <BookSide {...sideProps('buy')} mirrored />
            </div>
            <div>
              {banner('sell')}
              <Heads mirrored={false} />
              <BookSide {...sideProps('sell')} mirrored={false} />
            </div>
          </div>
        ) : (
          <div>
            {banner('sell')}
            <Heads mirrored={false} />
            <BookSide {...sideProps('sell')} mirrored={false} reversed />
            <div className="flex justify-center border-y border-line-strong py-3">
              <Middle bids={bids} asks={asks} />
            </div>
            <BookSide {...sideProps('buy')} mirrored={false} />
            {banner('buy')}
          </div>
        )}
      </ScrollArea>
      <div className="flex h-14 flex-none items-center border-t border-line">
        <Sweep
          side={hover?.side ?? 'sell'}
          rows={hover?.side === 'buy' ? bidRows : askRows}
          index={hover?.index ?? null}
        />
      </div>
    </Panel>
  );
}
