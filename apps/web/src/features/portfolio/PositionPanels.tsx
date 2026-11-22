import { useEffect, useRef, useState } from 'react';
import { freshness, useEquity, usePosition } from '@/api/queries';
import type { EquityPoint, EquityRange, Position } from '@/api/types';
import { createEquityChart, type EquityChart, type EquityColors } from '@/chart/equityChart';
import { Num } from '@/components/bits';
import { Panel } from '@/components/Panel';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/cn';
import { parseCash, showCash, showQty } from '@/lib/money';
import { usePrefs } from '@/lib/prefs';
import { QUOTE, SYMBOL } from '@/lib/rules';
import { showDateTime } from '@/lib/time';

/* Both panels read projections — tables written by event-log consumers — so
   each says how fresh its figures are. The balances above them come from the
   ledger and are never behind; these can be. */

const toneOf = (value: string): string => {
  const cents = parseCash(value) ?? 0n;
  return cents > 0n ? 'text-buy' : cents < 0n ? 'text-sell' : 'text-ink';
};

const arrowOf = (value: string): string => {
  const cents = parseCash(value) ?? 0n;
  return cents > 0n ? '▲ ' : cents < 0n ? '▼ ' : '';
};

function Figure({
  label,
  children,
  note,
}: {
  label: string;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-ink-3">{label}</dt>
      <dd className="num truncate text-xl font-semibold">{children}</dd>
      {note && <dd className="text-sm text-ink-2">{note}</dd>}
    </div>
  );
}

function PositionFigures({ p }: { p: Position }) {
  return (
    <dl className="grid grid-cols-2 gap-x-10 gap-y-5 px-7 pb-6 md:grid-cols-4">
      <Figure
        label="Average entry price"
        note={
          <>
            <Num>{showQty(p.quantity)}</Num> {SYMBOL} held, cost <Num>{showCash(p.costBasis)}</Num>
          </>
        }
      >
        {p.averageEntryPrice === null ? '—' : showCash(p.averageEntryPrice)}{' '}
        <span className="font-ui text-md font-medium text-ink-2">{QUOTE}</span>
      </Figure>
      <Figure
        label="Unrealised"
        note={
          <>
            held, at the last price <Num>{showCash(p.lastPrice)}</Num>
          </>
        }
      >
        <span className={toneOf(p.unrealisedPnl)}>
          {arrowOf(p.unrealisedPnl)}
          {showCash(p.unrealisedPnl, { sign: true })}
        </span>
      </Figure>
      <Figure label="Realised" note={<>from {p.sells} sells, fixed</>}>
        <span className={toneOf(p.realisedPnl)}>
          {arrowOf(p.realisedPnl)}
          {showCash(p.realisedPnl, { sign: true })}
        </span>
      </Figure>
      <Figure
        label="Fills counted"
        note={
          <>
            {p.buys} buys · {p.sells} sells
          </>
        }
      >
        {p.buys + p.sells}
      </Figure>
    </dl>
  );
}

export function PositionPanel() {
  const query = usePosition();
  const { stale, asOf } = freshness(query);
  const p = query.data;
  return (
    <Panel
      title="Your position"
      aside={
        <span className="text-sm text-ink-3">
          average cost ·{' '}
          {p?.asOf ? (
            <>
              as of <Num>{showDateTime(p.asOf)}</Num> UTC
            </>
          ) : (
            'no fills yet'
          )}
        </span>
      }
      staleSince={stale ? asOf : null}
      className="flex-none"
    >
      {p ? (
        <PositionFigures p={p} />
      ) : (
        <p className="px-7 pb-6 text-sm text-ink-3">
          {query.isError ? 'The position is not readable right now (—).' : 'Loading…'}
        </p>
      )}
      <p className="px-7 pb-6 text-sm text-ink-3">
        Built from the event log, so it can trail your balances by a few seconds. Average cost: a
        sell removes its share of what the coins cost, and the rest of the sale price is realised.
      </p>
    </Panel>
  );
}

function readColors(): EquityColors {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string): string => style.getPropertyValue(name).trim();
  return {
    equity: v('--color-cat-1'),
    contributed: v('--color-cat-2'),
    grid: v('--color-line'),
    text: v('--color-ink-3'),
    background: v('--color-surface'),
    fontFamily: v('--font-num'),
  };
}

const RANGES: { value: EquityRange; label: string }[] = [
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

function Swatch({ cssVar, dashed }: { cssVar: string; dashed?: boolean }) {
  return (
    <span
      aria-hidden
      className="inline-block h-0 w-6 align-middle"
      style={{ borderTop: `2px ${dashed ? 'dashed' : 'solid'} var(${cssVar})` }}
    />
  );
}

function EquityLegend({ point }: { point: EquityPoint | undefined }) {
  const gap = point
    ? (parseCash(point.equity) ?? 0n) - (parseCash(point.netContributed) ?? 0n)
    : null;
  return (
    <p
      className="num flex flex-wrap items-center gap-x-7 gap-y-1 px-7 text-sm text-ink-2"
      aria-live="off"
    >
      <span className="whitespace-nowrap">
        <Swatch cssVar="--color-cat-1" /> <span className="font-ui text-ink-3">Worth</span>{' '}
        {point ? showCash(point.equity) : '—'}
      </span>
      <span className="whitespace-nowrap">
        <Swatch cssVar="--color-cat-2" dashed />{' '}
        <span className="font-ui text-ink-3">Put in, net</span>{' '}
        {point ? showCash(point.netContributed) : '—'}
      </span>
      {gap !== null && (
        <b
          className={cn(
            'whitespace-nowrap font-semibold',
            gap > 0n ? 'text-buy' : gap < 0n ? 'text-sell' : '',
          )}
        >
          {gap > 0n ? '▲ ' : gap < 0n ? '▼ ' : ''}
          {showCash(gap, { sign: true })}
        </b>
      )}
      {point && <span className="font-ui text-ink-3">{showDateTime(point.at)} UTC</span>}
    </p>
  );
}

export function EquityPanel() {
  const [range, setRange] = useState<EquityRange>('7d');
  const query = useEquity(range);
  const { stale, asOf } = freshness(query);
  const points = query.data?.points;
  const container = useRef<HTMLDivElement | null>(null);
  const chart = useRef<EquityChart | null>(null);
  const [hoverAt, setHoverAt] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  const prefs = usePrefs();

  useEffect(() => {
    if (!container.current) return;
    const instance = createEquityChart(container.current, readColors());
    instance.onHover(setHoverAt);
    chart.current = instance;
    return () => {
      chart.current = null;
      instance.destroy();
    };
  }, []);

  useEffect(() => {
    chart.current?.setColors(readColors());
  }, [prefs.theme, prefs.scheme]);

  useEffect(() => {
    chart.current?.setPoints(points ?? []);
  }, [points]);

  const shown = (hoverAt && points?.find((p) => p.at === hoverAt)) || points?.at(-1);

  return (
    <Panel
      title="Worth over time"
      aside={<span className="text-sm text-ink-3">a snapshot every few minutes</span>}
      actions={
        <div className="flex items-center gap-4">
          <button
            type="button"
            className="rounded-tag text-sm text-info underline underline-offset-4"
            onClick={() => setTable((t) => !t)}
          >
            {table ? 'Show chart' : 'Show as table'}
          </button>
          <Segmented label="Range" value={range} onChange={setRange} options={RANGES} />
        </div>
      }
      staleSince={stale ? asOf : null}
      className="flex-none"
    >
      <EquityLegend point={shown} />
      <div ref={container} className={cn('mx-4 mt-3 mb-5 h-64', table && 'hidden')} />
      {table && (
        <div className="mx-7 mb-6 max-h-64 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-3">
                <th className="py-1 font-medium">When (UTC)</th>
                <th className="py-1 text-right font-medium">Worth</th>
                <th className="py-1 text-right font-medium">Put in, net</th>
              </tr>
            </thead>
            <tbody>
              {[...(points ?? [])].reverse().map((p) => (
                <tr key={p.at} className="border-t border-line">
                  <td className="py-1">{showDateTime(p.at)}</td>
                  <td className="num py-1 text-right">{showCash(p.equity)}</td>
                  <td className="num py-1 text-right">{showCash(p.netContributed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {points && points.length === 0 && (
        <p className="px-7 pb-6 text-sm text-ink-3">
          No snapshots in this range yet. They are taken every few minutes while the worker process
          is running; a gap means it was not.
        </p>
      )}
    </Panel>
  );
}
