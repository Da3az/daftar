import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
} from 'lightweight-charts';
import { useQuery } from '@tanstack/react-query';
import { fetchCandles } from '@/lib/prices';

/**
 * The live price chart.
 *
 * ## `attributionLogo` is left enabled, deliberately
 *
 * Lightweight Charts is Apache-2.0, and its one practical obligation is to
 * reproduce the attribution notice and link to tradingview.com from a page
 * users can see. The library's own docs state that leaving the attribution
 * logo on satisfies the linking requirement — so it stays on, the repo ships a
 * `NOTICE` file, and the footer links out as well. Turning the logo off would
 * be allowed only if the link were provided another way, and doing that to
 * save 60 pixels on a demo would be a poor trade.
 *
 * ## v5 API
 *
 * `chart.addSeries(CandlestickSeries, options)` — not v4's
 * `chart.addCandlestickSeries(options)`, which no longer exists. Verified
 * against the installed `typings.d.ts` rather than from memory.
 */
export function PriceChart({ symbol }: { symbol: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  const candles = useQuery({
    queryKey: ['candles', symbol],
    queryFn: () => fetchCandles(symbol),
    // Candles are historical and the newest one is a minute wide; refetching
    // faster than that redraws identical data.
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });

  // Create the chart once. Keyed on nothing, so a symbol change reuses the
  // same canvas and only replaces the series data.
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
      // Crosshair follows the pointer rather than snapping to a bar, which is
      // what a reader comparing a price against the frozen one actually wants.
      crosshair: { mode: 0 },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#4ec9a5',
      downColor: '#e8705f',
      borderVisible: false,
      wickUpColor: '#4ec9a5',
      wickDownColor: '#e8705f',
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Push data whenever it arrives or the symbol changes.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !candles.data) return;

    series.setData(
      candles.data.map((c) => ({
        // The library's `Time` type accepts a UNIX timestamp in **seconds**.
        time: c.time as never,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles.data]);

  return (
    <div className="relative">
      <div ref={containerRef} className="h-64 w-full" />

      {candles.isError && (
        <div className="bg-ink-950/70 absolute inset-0 flex items-center justify-center">
          <p className="text-ink-400 max-w-sm px-4 text-center text-xs">
            Market data unavailable. Binance geo-blocks some regions, so this is expected in them —
            nothing else on this page depends on it, because no price shown here is ever written to
            the ledger.
          </p>
        </div>
      )}
    </div>
  );
}
