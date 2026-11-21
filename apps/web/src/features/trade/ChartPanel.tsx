import { useEffect, useMemo, useRef, useState } from 'react';
import { freshness, useCandles } from '@/api/queries';
import type { Candle, CandleInterval, ExchangeOrder, OwnFill } from '@/api/types';
import { createLightweightChart } from '@/chart/lightweightChart';
import type {
  ChartColors,
  ChartLine,
  ChartMarker,
  PriceChart,
  PriceChartFactory,
} from '@/chart/PriceChart';
import { Panel } from '@/components/Panel';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/cn';
import { compareDecimal, formatQty, parseCash, parseQty, showCash, showQty } from '@/lib/money';
import { usePrefs } from '@/lib/prefs';
import { listen } from '@/app/actions';
import { countdownTo } from '@/lib/time';
import { useNow } from '@/lib/useNow';
import { check, rulesOf } from './ticketMath';
import { useTicket } from './ticketStore';

const INTERVALS: { value: CandleInterval; label: string; seconds: number }[] = [
  { value: '1m', label: '1 min', seconds: 60 },
  { value: '5m', label: '5 min', seconds: 300 },
  { value: '1h', label: '1 hour', seconds: 3600 },
];

function readColors(): ChartColors {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string): string => style.getPropertyValue(name).trim();
  return {
    up: v('--color-buy'),
    down: v('--color-sell'),
    grid: v('--color-line'),
    text: v('--color-ink-3'),
    background: v('--color-surface'),
    last: v('--color-ink-2'),
    buy: v('--color-buy'),
    sell: v('--color-sell'),
    draft: v('--color-you'),
    volumeOpacity: Number(v('--volume-opacity')) || 0.3,
    fontFamily: v('--font-num'),
  };
}

function Legend({
  candle,
  hovering,
  empty,
}: {
  candle: Candle | undefined;
  hovering: boolean;
  empty: boolean;
}) {
  if (!candle) {
    return (
      <p className="text-sm text-ink-3">
        {empty ? 'No trades in this range yet.' : hovering ? 'Nobody traded in this slot.' : ''}
      </p>
    );
  }
  const direction = compareDecimal(candle.close, candle.open, 2);
  const diff = (parseCash(candle.close) ?? 0n) - (parseCash(candle.open) ?? 0n);
  const item = (label: string, value: string) => (
    <span className="whitespace-nowrap">
      <span className="font-ui text-ink-3">{label}</span> {value}
    </span>
  );
  return (
    <p className="num flex flex-wrap gap-x-7 text-sm text-ink-2" aria-live="off">
      {item('Open', showCash(candle.open))}
      {item('High', showCash(candle.high))}
      {item('Low', showCash(candle.low))}
      {item('Close', showCash(candle.close))}
      <b
        className={cn(
          'whitespace-nowrap font-semibold',
          direction > 0 ? 'text-buy' : direction < 0 ? 'text-sell' : 'text-ink-2',
        )}
      >
        {direction > 0 ? '▲ ' : direction < 0 ? '▼ ' : ''}
        {showCash(diff, { sign: true })}
      </b>
      {item('Volume', showQty(candle.volume))}
    </p>
  );
}

export function ChartPanel({
  lastPrice,
  openOrders,
  fills,
  className,
  createChart = createLightweightChart,
}: {
  lastPrice: string | undefined;
  openOrders: ExchangeOrder[] | undefined;
  fills: OwnFill[] | undefined;
  className?: string;
  createChart?: PriceChartFactory;
}) {
  const [interval, setInterval] = useState<CandleInterval>('1m');
  const seconds = INTERVALS.find((item) => item.value === interval)?.seconds ?? 60;
  const query = useCandles(interval);
  const { stale, asOf } = freshness(query);
  const candles = query.data?.candles;
  const container = useRef<HTMLDivElement | null>(null);
  const chart = useRef<PriceChart | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const prefs = usePrefs();
  const now = useNow();
  const ticket = useTicket();

  useEffect(() => listen<CandleInterval>('daftar:interval', setInterval), []);

  useEffect(() => {
    if (!container.current) return;
    const instance = createChart(container.current, readColors());
    instance.onHover(setHoverTime);
    chart.current = instance;
    return () => {
      chart.current = null;
      instance.destroy();
    };
  }, [createChart]);

  useEffect(() => {
    chart.current?.setColors(readColors());
  }, [prefs.theme, prefs.scheme]);

  useEffect(() => {
    if (candles && query.data?.interval === interval)
      chart.current?.setBars(candles, seconds, Date.now());
  }, [candles, interval, seconds, query.data?.interval]);

  const draft = useMemo(() => {
    const { values } = ticket;
    if (values.type !== 'limit') return null;
    const checked = check(values, rulesOf(undefined));
    return checked.priceCents === null
      ? null
      : { price: values.price.trim(), side: values.side, quantity: checked.qtyUnits };
  }, [ticket]);

  const lines = useMemo<ChartLine[]>(() => {
    const list: ChartLine[] = [];
    for (const order of openOrders ?? []) {
      if (!order.limitPrice || order.status !== 'open') continue;
      const left = (parseQty(order.quantity) ?? 0n) - (parseQty(order.filledQuantity) ?? 0n);
      list.push({
        id: order.clientOrderId,
        price: order.limitPrice,
        kind: order.side,
        label: `${order.side === 'buy' ? 'Buy' : 'Sell'} ${showQty(formatQty(left))}`,
      });
    }
    if (draft)
      list.push({
        id: 'draft',
        price: draft.price,
        kind: 'draft',
        label: `Draft ${draft.side}${draft.quantity ? ` ${showQty(draft.quantity)}` : ''}`,
      });
    return list;
  }, [openOrders, draft]);

  const markers = useMemo<ChartMarker[]>(() => {
    const buckets = new Map<string, { time: number; side: 'buy' | 'sell'; units: bigint }>();
    for (const fill of fills ?? []) {
      const at = Date.parse(fill.createdAt);
      if (Number.isNaN(at)) continue;
      const time = Math.floor(at / 1000 / seconds) * seconds;
      const key = `${time}:${fill.side}`;
      const entry = buckets.get(key) ?? { time, side: fill.side, units: 0n };
      entry.units += parseQty(fill.quantity) ?? 0n;
      buckets.set(key, entry);
    }
    return [...buckets.values()].map((entry) => ({
      time: entry.time,
      side: entry.side,
      label: `${entry.side === 'buy' ? 'B' : 'S'} ${showQty(entry.units)}`,
    }));
  }, [fills, seconds]);

  useEffect(() => {
    chart.current?.setLines(lines);
  }, [lines]);
  useEffect(() => {
    chart.current?.setMarkers(markers);
  }, [markers]);

  const shown =
    hoverTime !== null
      ? candles?.find((candle) => candle.time === hoverTime)
      : candles?.[candles.length - 1];
  const lastY = lastPrice ? (chart.current?.priceY(lastPrice) ?? null) : null;

  return (
    <Panel
      title="Price"
      aside={
        <Segmented
          label="Candle interval"
          value={interval}
          onChange={setInterval}
          options={INTERVALS.map(({ value, label }) => ({ value, label }))}
        />
      }
      actions={
        <span className="hidden text-sm text-ink-3 md:inline">
          Gaps are times when nobody traded
        </span>
      }
      staleSince={stale ? asOf : null}
      className={className}
    >
      <div className="min-h-9 px-7">
        <Legend
          candle={shown}
          hovering={hoverTime !== null}
          empty={candles !== undefined && candles.length === 0}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={container}
          className="absolute inset-0"
          role="img"
          aria-label={`Candlestick chart of ${interval} prices. Last price ${showCash(lastPrice)}.`}
        />
        {lastY !== null && (
          <span
            className="num pointer-events-none absolute right-1 z-10 rounded-tag bg-ink-2 px-2 text-xs text-surface"
            style={{ top: lastY + 11 }}
            title="Time until this candle closes"
          >
            {countdownTo(seconds, now)}
          </span>
        )}
        {query.isPending && (
          <p className="absolute inset-0 grid place-items-center text-sm text-ink-3">
            Loading prices…
          </p>
        )}
      </div>
    </Panel>
  );
}
