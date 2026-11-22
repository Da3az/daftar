import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '@/api/client';
import { useApi } from '@/api/context';
import { keys, useRecurring } from '@/api/queries';
import type { Cadence, RecurringPlan } from '@/api/types';
import { Button, Callout, Num } from '@/components/bits';
import { Segmented } from '@/components/ui/segmented';
import { formatCash, showCash, showQty } from '@/lib/money';
import { QUOTE, SYMBOL } from '@/lib/rules';
import { showDateTime } from '@/lib/time';
import { AmountField, checkAmount } from '../portfolio/CashPanel';

/* A recurring buy spends a fixed amount at a fixed cadence. Each run is a
   market buy through the same order path as the ticket, keyed by plan and
   scheduled time so a run is one order however often it fires. */

const CADENCES: { value: Cadence; label: string }[] = [
  { value: '1m', label: 'Every minute' },
  { value: '1h', label: 'Hourly' },
  { value: '1d', label: 'Daily' },
  { value: '1w', label: 'Weekly' },
];

const cadenceLabel = (c: Cadence | null) => CADENCES.find((x) => x.value === c)?.label ?? 'Custom';

function PlanRow({ plan }: { plan: RecurringPlan }) {
  const api = useApi();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: keys.recurring });
  const toggle = useMutation({
    mutationFn: () => api.setRecurringActive(plan.id, plan.status !== 'active'),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteRecurring(plan.id),
    onSettled: refresh,
  });
  return (
    <li className="border-t border-line py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <span className="font-semibold">
          <Num>{showCash(plan.amount)}</Num> {QUOTE} · {cadenceLabel(plan.cadence)}
        </span>
        <span className="text-sm text-ink-2">
          {plan.status === 'active' ? (
            <>
              next <Num>{plan.nextRunAt ? showDateTime(plan.nextRunAt) : '—'}</Num> UTC
            </>
          ) : (
            'paused'
          )}
        </span>
      </div>
      <p className="mt-1 text-sm text-ink-2">
        Bought <Num>{showQty(plan.bought)}</Num> {SYMBOL} for <Num>{showCash(plan.spent)}</Num>
        {plan.averagePrice && (
          <>
            {' '}
            · average <Num>{showCash(plan.averagePrice)}</Num> per coin
          </>
        )}
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <Button disabled={toggle.isPending} onClick={() => toggle.mutate()}>
          {plan.status === 'active' ? 'Pause' : 'Resume'}
        </Button>
        <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
          Delete
        </Button>
        <button
          type="button"
          className="rounded-tag text-sm text-info underline underline-offset-4"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? 'Hide runs' : `Runs (${plan.runs.length})`}
        </button>
      </div>
      {open && (
        <ol className="mt-3 flex flex-col gap-1 text-sm">
          {plan.runs.length === 0 && <li className="text-ink-3">No runs yet.</li>}
          {plan.runs.map((r) => (
            <li key={r.scheduledFor} className="flex gap-4">
              <span className="num w-44 flex-none text-ink-3">{showDateTime(r.scheduledFor)}</span>
              <span className="text-ink-2">
                {r.status === 'skipped' ? (
                  <>Skipped — {r.reason}</>
                ) : (
                  <>
                    {r.status === 'partial' ? 'Partly bought' : 'Bought'}{' '}
                    <Num>{showQty(r.quantity)}</Num> for <Num>{showCash(r.notional)}</Num>
                  </>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export function RecurringPanel() {
  const api = useApi();
  const client = useQueryClient();
  const query = useRecurring();
  const id = useId();
  const [amount, setAmount] = useState('');
  const [cadence, setCadence] = useState<Cadence>('1d');
  const { cents, issue } = checkAmount(amount, 100_000_000n, '1,000,000.00');
  const create = useMutation({
    mutationFn: () => api.createRecurring({ amount: formatCash(cents ?? 0n), cadence }),
    onSuccess: () => setAmount(''),
    onSettled: () => client.invalidateQueries({ queryKey: keys.recurring }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (cents !== null && !create.isPending) create.mutate();
  };
  const plans = query.data?.plans ?? [];
  return (
    <div className="flex flex-col gap-5 px-7 pb-6">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <AmountField id={id} value={amount} onChange={setAmount} issue={issue} />
        <Segmented label="How often" value={cadence} onChange={setCadence} options={CADENCES} />
        <p className="text-sm text-ink-3">
          Each run buys {SYMBOL} at market for at most this much, at the prices on the book when it
          runs. If there is not enough cash then, the run is skipped and you are notified. Runs
          missed while the server was down are not made up.
        </p>
        <Button type="submit" variant="buy" disabled={cents === null || create.isPending}>
          {create.isPending ? 'Starting…' : 'Start recurring buy'}
        </Button>
        {create.isError && (
          <Callout tone="danger" title="Not started">
            {create.error instanceof ApiError
              ? create.error.message
              : 'The server could not be reached.'}
          </Callout>
        )}
      </form>
      {plans.length > 0 && (
        <section>
          <h3 className="text-sm text-ink-3">Your recurring buys</h3>
          <ul>
            {plans.map((p) => (
              <PlanRow key={p.id} plan={p} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
