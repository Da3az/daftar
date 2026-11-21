import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useQuery } from '@tanstack/react-query';
import { getCandles, type CandleInterval } from '@/lib/exchange';
import { Card, CardHeader } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';

const INTERVALS: CandleInterval[] = ['1m', '5m', '1h'];

/**
 * Candles for the made-up coin, aggregated by the API from its own trades.
 *
 * Unlike the legacy chart, **every price drawn here is a price somebody
 * actually paid on this exchange** — there is no outside feed. The frozen-price
 * caveat that covers the legacy pages does not apply and is not repeated.
 *
 * ## The one sanctioned `Number()` on a price
 *
 * The charting library takes `number`s. Prices here are converted for drawing
 * and for nothing else: they set pixel positions, and at two decimal places and
 * a 10,000.00 ceiling they are far inside what a double represents exactly. No
 * value read back out of the chart is ever used.
 *
 * `attributionLogo` stays on, deliberately. Lightweight Charts is Apache-2.0,
 * and its one practical obligation is to reproduce the attribution notice and
 * link to tradingview.com from a page users can see. The library's own docs
 * state that leaving the attribution logo on satisfies the linking requirement
 * — so it stays on, the repo ships a `NOTICE` file, and the footer links out
 * as well.
 */
export function ExchangeChart({ symbol }: { symbol: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  /** Whether the visible range has been fitted for the current interval. */
  const fittedRef = useRef(false);

  const [interval, setCandleInterval] = useState<CandleInterval>('1m');

  const candles = useQuery({
    queryKey: ['exchange', 'candles', interval],
    queryFn: () => getCandles(interval),
    staleTime: 0,
    // The newest candle is still forming, so it is refetched; five seconds is
    // often enough to watch it move and a fifth of the book's poll rate.
    refetchInterval: 5_000,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8b9099',
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true },
      autoSize: true,
      crosshair: { mode: 0 },
    });

    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: '#4ec9a5',
      downColor: '#e8705f',
      borderVisible: false,
      wickUpColor: '#4ec9a5',
      wickDownColor: '#e8705f',
    });
    chartRef.current = chart;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    fittedRef.current = false;
  }, [interval]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !candles.data) return;

    series.setData(
      candles.data.candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
      })),
    );

    // Fit once per interval, not on every poll: refitting every five seconds
    // would snap the view back while the reader is scrolled into the history.
    if (!fittedRef.current && candles.data.candles.length > 0) {
      chartRef.current?.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [candles.data]);

  return (
    <Card>
      <CardHeader
        title={`${symbol} / USD`}
        hint="Every candle is built from trades on this book."
        actions={
          <div className="flex gap-1">
            {INTERVALS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setCandleInterval(option)}
                className={cn(
                  'rounded px-2 py-1 text-xs',
                  option === interval
                    ? 'bg-ink-700 text-ink-50'
                    : 'text-ink-400 hover:bg-ink-800 hover:text-ink-100',
                )}
              >
                {option}
              </button>
            ))}
          </div>
        }
      />
      <div className="relative p-2">
        <div ref={containerRef} className="h-80 w-full" />
        {candles.data?.candles.length === 0 && (
          <p className="text-ink-500 absolute inset-0 flex items-center justify-center text-sm">
            No trades in this window yet.
          </p>
        )}
      </div>
    </Card>
  );
}
