import type { Candle, Side } from '@/api/types';

/* The price chart sits behind this interface so the drawing engine can be swapped.
   Amounts cross it as exact decimal strings; only the implementation turns them into
   numbers, and only for pixel positions. */

export interface ChartLine {
  id: string;
  price: string;
  /** Shown on the line: "Buy 12.00". */
  label: string;
  kind: Side | 'draft';
}

export interface ChartMarker {
  /** Bucket start, Unix seconds. */
  time: number;
  side: Side;
  /** "B 4.00" */
  label: string;
}

export interface ChartColors {
  up: string;
  down: string;
  grid: string;
  text: string;
  background: string;
  last: string;
  buy: string;
  sell: string;
  draft: string;
  volumeOpacity: number;
  fontFamily: string;
}

export interface PriceChart {
  /** Replace or extend the series. Buckets with no trade are left as empty slots. */
  setBars(candles: Candle[], intervalSeconds: number, nowMs: number): void;
  setLines(lines: ChartLine[]): void;
  setMarkers(markers: ChartMarker[]): void;
  setColors(colors: ChartColors): void;
  /** Called with the hovered bucket's start time, or null when the pointer leaves. */
  onHover(listener: (time: number | null) => void): void;
  /** Vertical pixel position of a price inside the chart, for overlays. null when off-screen or unknown. */
  priceY(price: string): number | null;
  destroy(): void;
}

export type PriceChartFactory = (container: HTMLElement, colors: ChartColors) => PriceChart;
