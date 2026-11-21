import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  type CandlestickData,
  type HistogramData,
  type IPriceLine,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts';
import type { Candle } from '@/api/types';
import { numberForChart } from '@/lib/money';
import type { ChartLine, ChartMarker, PriceChartFactory } from './PriceChart';

const MAX_SLOTS = 600;

function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return Number.isNaN(n)
    ? hex
    : `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const pad = (n: number): string => String(n).padStart(2, '0');
function utcLabel(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** TradingView Lightweight Charts (Apache-2.0). Its attribution logo is left on, which satisfies the licence notice. */
export const createLightweightChart: PriceChartFactory = (container, initialColors) => {
  let colors = initialColors;
  const chart = createChart(container, {
    autoSize: true,
    layout: {
      attributionLogo: true,
      background: { color: colors.background },
      textColor: colors.text,
      fontFamily: colors.fontFamily,
      fontSize: 11,
    },
    grid: { vertLines: { visible: false }, horzLines: { color: colors.grid } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
    timeScale: {
      borderVisible: false,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 3,
      ignoreWhitespaceIndices: false,
    },
    localization: {
      timeFormatter: (time: unknown) => (typeof time === 'number' ? utcLabel(time) : ''),
    },
  });
  const candles = chart.addSeries(CandlestickSeries, {
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    priceLineStyle: LineStyle.Dotted,
  });
  const volume = chart.addSeries(HistogramSeries, {
    priceScaleId: 'volume',
    priceFormat: { type: 'volume' },
    lastValueVisible: false,
    priceLineVisible: false,
  });
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
  const markers = createSeriesMarkers(candles, []);

  let seriesKey = '';
  let lastTime = 0;
  let lines = new Map<string, { line: IPriceLine; signature: string }>();
  let currentLines: ChartLine[] = [];
  let currentMarkers: ChartMarker[] = [];
  let lastCandles: Candle[] = [];
  let lastInterval = 60;
  let lastNow = 0;

  const paint = (): void => {
    chart.applyOptions({
      layout: {
        background: { color: colors.background },
        textColor: colors.text,
        fontFamily: colors.fontFamily,
      },
      grid: { horzLines: { color: colors.grid } },
    });
    candles.applyOptions({
      upColor: colors.up,
      borderUpColor: colors.up,
      wickUpColor: colors.up,
      downColor: colors.down,
      borderDownColor: colors.down,
      wickDownColor: colors.down,
      priceLineColor: colors.last,
    });
  };
  paint();

  // SANCTIONED float use: the chart library positions bars by number. Display text never comes from these.
  const toBar = (c: Candle): CandlestickData<UTCTimestamp> => ({
    time: c.time as UTCTimestamp,
    open: numberForChart(c.open),
    high: numberForChart(c.high),
    low: numberForChart(c.low),
    close: numberForChart(c.close),
  });
  const toVolume = (c: Candle): HistogramData<UTCTimestamp> => ({
    time: c.time as UTCTimestamp,
    value: numberForChart(c.volume),
    color: rgba(
      numberForChart(c.close) >= numberForChart(c.open) ? colors.up : colors.down,
      colors.volumeOpacity,
    ),
  });
  const valid = (c: Candle): boolean =>
    Number.isFinite(c.time) &&
    [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(numberForChart(v)));

  const draw = (
    list: Candle[],
    intervalSeconds: number,
    nowMs: number,
    forceFull: boolean,
  ): void => {
    const good = list.filter(valid);
    const first = good[0];
    const key = `${intervalSeconds}:${first?.time ?? 0}`;
    const nowBucket = Math.floor(nowMs / 1000 / intervalSeconds) * intervalSeconds;
    if (!first) {
      candles.setData([]);
      volume.setData([]);
      seriesKey = key;
      lastTime = 0;
      return;
    }
    const byTime = new Map(good.map((c) => [c.time, c]));
    const start = Math.max(first.time, nowBucket - MAX_SLOTS * intervalSeconds);
    const slot = (
      time: number,
    ): [
      CandlestickData<UTCTimestamp> | WhitespaceData<UTCTimestamp>,
      HistogramData<UTCTimestamp> | WhitespaceData<UTCTimestamp>,
    ] => {
      const c = byTime.get(time);
      return c
        ? [toBar(c), toVolume(c)]
        : [{ time: time as UTCTimestamp }, { time: time as UTCTimestamp }];
    };
    if (!forceFull && key === seriesKey && lastTime > 0 && nowBucket >= lastTime) {
      try {
        for (let time = lastTime; time <= nowBucket; time += intervalSeconds) {
          const [bar, vol] = slot(time);
          candles.update(bar);
          volume.update(vol);
        }
        lastTime = nowBucket;
        return;
      } catch {
        /* update() refuses a bar older than the last one (a stale poll); fall through to a full redraw */
      }
    }
    const bars: (CandlestickData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] = [];
    const vols: (HistogramData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] = [];
    for (let time = start; time <= Math.max(nowBucket, first.time); time += intervalSeconds) {
      const [bar, vol] = slot(time);
      bars.push(bar);
      vols.push(vol);
    }
    const interval_changed = key !== seriesKey;
    candles.setData(bars);
    volume.setData(vols);
    if (interval_changed) chart.timeScale().scrollToRealTime();
    seriesKey = key;
    lastTime = Math.max(nowBucket, first.time);
  };

  const drawLines = (): void => {
    const next = new Map<string, { line: IPriceLine; signature: string }>();
    for (const item of currentLines) {
      const price = numberForChart(item.price);
      if (!Number.isFinite(price)) continue;
      const color =
        item.kind === 'draft' ? colors.draft : item.kind === 'buy' ? colors.buy : colors.sell;
      const signature = `${item.price}|${item.label}|${color}`;
      const existing = lines.get(item.id);
      if (existing && existing.signature === signature) {
        next.set(item.id, existing);
        continue;
      }
      if (existing) candles.removePriceLine(existing.line);
      const line = candles.createPriceLine({
        price,
        color,
        title: item.label,
        lineWidth: 1,
        axisLabelVisible: true,
        lineStyle: item.kind === 'draft' ? LineStyle.Dotted : LineStyle.Dashed,
      });
      next.set(item.id, { line, signature });
    }
    for (const [id, existing] of lines) if (!next.has(id)) candles.removePriceLine(existing.line);
    lines = next;
  };

  const drawMarkers = (): void => {
    markers.setMarkers(
      [...currentMarkers]
        .sort((a, b) => a.time - b.time)
        .map((m) => ({
          time: m.time as UTCTimestamp,
          position: m.side === 'buy' ? ('belowBar' as const) : ('aboveBar' as const),
          shape: m.side === 'buy' ? ('arrowUp' as const) : ('arrowDown' as const),
          color: m.side === 'buy' ? colors.buy : colors.sell,
          text: m.label,
        })),
    );
  };

  let hover: ((time: number | null) => void) | null = null;
  chart.subscribeCrosshairMove((param) =>
    hover?.(typeof param.time === 'number' && param.point ? param.time : null),
  );

  return {
    setBars(list, intervalSeconds, nowMs) {
      lastCandles = list;
      lastInterval = intervalSeconds;
      lastNow = nowMs;
      draw(list, intervalSeconds, nowMs, false);
    },
    setLines(next) {
      currentLines = next;
      drawLines();
    },
    setMarkers(next) {
      currentMarkers = next;
      drawMarkers();
    },
    setColors(next) {
      colors = next;
      paint();
      draw(lastCandles, lastInterval, lastNow, true);
      for (const existing of lines.values()) candles.removePriceLine(existing.line);
      lines = new Map();
      drawLines();
      drawMarkers();
    },
    onHover(listener) {
      hover = listener;
    },
    priceY(price) {
      const value = numberForChart(price);
      return Number.isFinite(value) ? candles.priceToCoordinate(value) : null;
    },
    destroy() {
      hover = null;
      chart.remove();
    },
  };
};
