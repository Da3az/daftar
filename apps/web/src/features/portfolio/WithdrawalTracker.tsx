import { useState } from 'react';
import { freshness, useWithdrawals } from '@/api/queries';
import type { Withdrawal, WithdrawalState } from '@/api/types';
import { Num } from '@/components/bits';
import { Panel } from '@/components/Panel';
import { cn } from '@/lib/cn';
import { showCash } from '@/lib/money';
import { QUOTE } from '@/lib/rules';
import { showDateTime } from '@/lib/time';

/* A withdrawal is a saga: requested → on hold → sent to the payout rail →
   paid out, or returned to your cash. The stepper shows where each one is;
   the history underneath is the database's own record of every transition. */

const STEPS = ['Requested', 'On hold', 'Sent', 'Done'] as const;

const STATE_LABEL: Record<WithdrawalState, string> = {
  requested: 'Requested',
  held: 'On hold, waiting to be sent',
  review: 'Waiting for a review',
  submitted: 'Sent, waiting for the rail to confirm',
  confirmed: 'Paid out',
  failed: 'Failed, returning your cash',
  released: 'Returned to your cash',
};

function Stepper({ w }: { w: Withdrawal }) {
  const returned = w.outcome === 'returned';
  return (
    <ol className="flex items-center gap-2" aria-label={`Progress: ${STATE_LABEL[w.state]}`}>
      {STEPS.map((label, i) => {
        const done = i < w.step || (i === w.step && w.outcome !== 'in_progress');
        const current = i === w.step && w.outcome === 'in_progress';
        const last = i === STEPS.length - 1;
        return (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className={cn(
                'flex h-6 w-6 flex-none items-center justify-center rounded-full border text-xs',
                done && !returned && 'border-buy bg-buy text-on-buy',
                done && returned && 'border-ink-2 bg-ink-2 text-surface',
                current && 'border-info text-info',
                !done && !current && 'border-line text-ink-3',
              )}
              aria-hidden
            >
              {done ? '✓' : i + 1}
            </span>
            <span
              className={cn(
                'truncate text-sm',
                current ? 'font-semibold text-ink' : done ? 'text-ink-2' : 'text-ink-3',
              )}
            >
              {last && returned
                ? 'Returned'
                : last && w.outcome === 'paid_out'
                  ? 'Paid out'
                  : label}
              {current && w.inReview && ' · review'}
            </span>
            {!last && <span className="h-px min-w-3 flex-1 bg-line" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

function Row({ w }: { w: Withdrawal }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t border-line px-7 py-4 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <span className="text-md font-semibold">
          <Num>{showCash(w.amount)}</Num> {QUOTE}
        </span>
        <span className="text-sm text-ink-2">{STATE_LABEL[w.state]}</span>
        <span className="text-sm text-ink-3">
          <Num>{showDateTime(w.createdAt)}</Num> UTC
        </span>
      </div>
      <div className="mt-3">
        <Stepper w={w} />
      </div>
      <button
        type="button"
        className="mt-3 rounded-tag text-sm text-info underline underline-offset-4"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? 'Hide history' : `History (${w.history.length})`}
      </button>
      {open && (
        <ol className="mt-2 flex flex-col gap-1 text-sm">
          {w.history.map((t, i) => (
            <li key={i} className="flex gap-4">
              <span className="num w-44 flex-none text-ink-3">{showDateTime(t.at)}</span>
              <span className="text-ink-2">
                {t.from ? `${t.from} → ` : ''}
                <b className="font-semibold text-ink">{t.to}</b>
                {t.reason ? ` — ${t.reason}` : ''}
              </span>
            </li>
          ))}
          {w.submitAttempts > 1 && (
            <li className="text-ink-3">
              Sent to the rail {w.submitAttempts} times; it is told the same reference each time, so
              it pays once.
            </li>
          )}
        </ol>
      )}
    </li>
  );
}

export function WithdrawalTracker() {
  const query = useWithdrawals();
  const { stale, asOf } = freshness(query);
  const list = query.data?.withdrawals ?? [];
  if (query.data && list.length === 0) return null;
  return (
    <Panel title="Withdrawals" staleSince={stale ? asOf : null} className="flex-none">
      {query.isPending ? (
        <p className="px-7 pb-6 text-sm text-ink-3">Loading…</p>
      ) : (
        <ul className="pb-3">
          {list.map((w) => (
            <Row key={w.id} w={w} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
