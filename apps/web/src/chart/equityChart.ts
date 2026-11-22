import {
  createChart,
  CrosshairMode,
  LineSeries,
  LineStyle,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { EquityPoint } from '@/api/types';
import { numberForChart } from '@/lib/money';

/* Equity over time: one solid line (what the account is worth) and one dashed
   reference line (what was put in, net). One axis, both in the quote currency,
   so the vertical gap between them is the profit or loss — no second scale.
   Dashed vs solid is the secondary encoding, so identity never rests on hue. */

export interface EquityColors {
  equity: string;
  contributed: string;
  grid: string;
  text: string;
  background: string;
  fontFamily: string;
}

export interface EquityHover {
  /** The hovered point's `at`, or null when the pointer leaves. */
  at: string | null;
}

export interface EquityChart {
  setPoints(points: EquityPoint[]): void;
  setColors(colors: EquityColors): void;
  onHover(listener: (at: string | null) => void): void;
  destroy(): void;
}

export function createEquityChart(container: HTMLElement, initial: EquityColors): EquityChart {
  let colors = initial;
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
    crosshair: { mode: CrosshairMode.Magnet },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
  });

  const equity = chart.addSeries(LineSeries, {
    lineWidth: 2,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    lastValueVisible: true,
    priceLineVisible: false,
  });
  const contributed = chart.addSeries(LineSeries, {
    lineWidth: 2,
    lineStyle: LineStyle.Dashed,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  });

  const paint = (): void => {
    chart.applyOptions({
      layout: {
        background: { color: colors.background },
        textColor: colors.text,
        fontFamily: colors.fontFamily,
      },
      grid: { horzLines: { color: colors.grid } },
    });
    equity.applyOptions({ color: colors.equity });
    contributed.applyOptions({ color: colors.contributed });
  };
  paint();

  const byTime = new Map<number, string>();
  let hover: ((at: string | null) => void) | null = null;

  chart.subscribeCrosshairMove((param) => {
    if (!hover) return;
    const t = typeof param.time === 'number' ? param.time : null;
    hover(t === null ? null : (byTime.get(t) ?? null));
  });

  return {
    setPoints(points) {
      byTime.clear();
      // SANCTIONED float use: positions only. Every number shown as text comes from the strings.
      const e: LineData<UTCTimestamp>[] = [];
      const c: LineData<UTCTimestamp>[] = [];
      let last = -1;
      for (const p of points) {
        const time = Math.floor(Date.parse(p.at) / 1000);
        if (!Number.isFinite(time) || time <= last) continue;
        const ev = numberForChart(p.equity);
        const cv = numberForChart(p.netContributed);
        if (!Number.isFinite(ev) || !Number.isFinite(cv)) continue;
        last = time;
        byTime.set(time, p.at);
        e.push({ time: time as UTCTimestamp, value: ev });
        c.push({ time: time as UTCTimestamp, value: cv });
      }
      equity.setData(e);
      contributed.setData(c);
      chart.timeScale().fitContent();
    },
    setColors(next) {
      colors = next;
      paint();
    },
    onHover(listener) {
      hover = listener;
    },
    destroy() {
      chart.remove();
    },
  };
}
