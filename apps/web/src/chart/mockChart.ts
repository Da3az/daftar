import type { PriceChart, PriceChartFactory } from './PriceChart';

/** A chart that draws nothing and records what it was told — for tests and for running without a canvas. */
export interface RecordingChart extends PriceChart {
  calls: { method: string; args: unknown[] }[];
}

export const createMockChart: PriceChartFactory = (container) => {
  const calls: RecordingChart['calls'] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  container.dataset.chart = 'mock';
  const chart: RecordingChart = {
    calls,
    setBars: record('setBars'),
    setLines: record('setLines'),
    setMarkers: record('setMarkers'),
    setColors: record('setColors'),
    onHover: record('onHover'),
    priceY: () => null,
    destroy: record('destroy'),
  };
  return chart;
};
