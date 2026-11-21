import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError } from '@/api/client';
import { useApi } from '@/api/context';
import { useRefreshSession } from '@/api/queries';
import type { DepositResult, Me, MovementResult } from '@/api/types';
import { Button, Callout, CopyButton, LinkButton, Num, StateChip } from '@/components/bits';
import { Panel } from '@/components/Panel';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Segmented } from '@/components/ui/segmented';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/cn';
import { groupHandle, HANDLE_PATTERN, newClientId } from '@/lib/ids';
import { formatCash, parseCash, parseUnits, showCash } from '@/lib/money';
import { DELIVERY_CHOICES, MAX_DEPOSIT_CENTS, MAX_MOVEMENT_CENTS, QUOTE } from '@/lib/rules';
import { describeCashError, type Refusal } from '../errors';
import { useReceipt } from '../history/Receipt';
import { SetAsideList } from '../trade/YourMoney';

type Mode = 'deposit' | 'withdraw' | 'send';

function AmountField({
  id,
  value,
  onChange,
  issue,
  hint,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  issue?: string | null;
  hint?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-4 text-sm text-ink-2">
        <label htmlFor={id}>Amount</label>
        <span>{hint}</span>
      </div>
      <div
        className={cn(
          'flex h-19 items-center rounded-field border-[length:var(--border-field)] border-field bg-surface px-6 focus-within:shadow-focus',
          issue && 'border-danger',
        )}
      >
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          aria-invalid={Boolean(issue)}
          className="num min-w-0 flex-1 bg-transparent text-xl font-semibold outline-none placeholder:font-normal placeholder:text-ink-3 focus-visible:shadow-none"
        />
        <span className="text-sm font-semibold text-ink-3">{QUOTE}</span>
      </div>
      {issue && <p className="mt-2 text-sm text-danger">{issue}</p>}
    </div>
  );
}

function checkAmount(
  text: string,
  max: bigint,
  maxLabel: string,
): { cents: bigint | null; issue: string | null } {
  if (text.trim() === '') return { cents: null, issue: null };
  const cents = parseUnits(text.trim(), 2);
  if (cents === null)
    return { cents: null, issue: 'Enter an amount with at most two decimals, like 250.00.' };
  if (cents <= 0n) return { cents: null, issue: 'The amount must be more than zero.' };
  if (cents > max) return { cents: null, issue: `The most allowed at once is ${maxLabel}.` };
  return { cents, issue: null };
}

const OUTCOMES: Record<
  string,
  {
    word: string;
    tone: 'filled' | 'replayed' | 'partial' | 'danger';
    shape: 'outline' | 'dashed';
    effect: string;
  }
> = {
  processed: { word: 'Processed', tone: 'filled', shape: 'outline', effect: 'credited your cash' },
  duplicate: {
    word: 'Duplicate',
    tone: 'replayed',
    shape: 'outline',
    effect: 'recognised, no effect',
  },
  in_progress: {
    word: 'Told to retry',
    tone: 'partial',
    shape: 'dashed',
    effect: 'the first copy was still being handled',
  },
};

/** The per-delivery log: which copy counted, which were recognised as duplicates, which were told to come back. */
export function DeliveryLog({ result }: { result: DepositResult }) {
  const { summary } = result;
  const sent = result.deliveries.filter((delivery) => delivery.retry === 0).length;
  return (
    <div className="flex flex-col gap-4">
      <Callout
        tone={result.credited ? 'success' : 'danger'}
        title={
          result.credited ? (
            <>
              Credited exactly once: +<Num>{showCash(result.amount)}</Num> {QUOTE}
            </>
          ) : (
            'Not credited'
          )
        }
        role="status"
      >
        The provider delivered the same event <Num>{sent}</Num>{' '}
        {sent === 1 ? 'time' : 'times at once'}
        {result.deliveries.length > sent ? (
          <>
            {' '}
            (<Num>{result.deliveries.length}</Num> attempts counting retries)
          </>
        ) : null}
        : <Num>{summary.processed}</Num> processed
        {summary.duplicates > 0 && (
          <>
            , <Num>{summary.duplicates}</Num>{' '}
            {summary.duplicates === 1 ? 'duplicate' : 'duplicates'}
          </>
        )}
        {summary.inProgress > 0 && (
          <>
            , <Num>{summary.inProgress}</Num> told to retry
          </>
        )}
        {summary.rejected > 0 && (
          <>
            , <Num>{summary.rejected}</Num> rejected
          </>
        )}
        . Your cash is now <Num>{showCash(result.cashBalance)}</Num>.
      </Callout>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-ink-3">
            <th className="py-1 text-left font-medium">Delivery</th>
            <th className="py-1 text-left font-medium">Attempt</th>
            <th className="py-1 text-left font-medium">Answer</th>
            <th className="py-1 text-left font-medium">Outcome</th>
            <th className="py-1 text-right font-medium">Took</th>
          </tr>
        </thead>
        <tbody>
          {result.deliveries.map((delivery, index) => {
            const outcome = OUTCOMES[delivery.outcome] ?? {
              word: delivery.outcome || '—',
              tone: 'danger' as const,
              shape: 'outline' as const,
              effect: 'rejected',
            };
            return (
              <tr
                key={index}
                className={cn(
                  'border-b border-line',
                  delivery.outcome === 'processed' && 'bg-success-wash',
                )}
              >
                <td className="num py-2 pl-2">#{delivery.delivery}</td>
                <td className="py-2">
                  {delivery.retry === 0 ? 'first' : `retry ${delivery.retry}`}
                </td>
                <td className="num py-2">{delivery.status}</td>
                <td className="py-2">
                  <StateChip tone={outcome.tone} shape={outcome.shape}>
                    {outcome.word}
                  </StateChip>{' '}
                  <span className="ml-2 text-ink-3">{outcome.effect}</span>
                </td>
                <td className="num py-2 pr-2 text-right text-ink-3">
                  {typeof delivery.latencyMs === 'number' ? `${delivery.latencyMs} ms` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="num text-xs text-ink-3">{result.depositId}</p>
    </div>
  );
}

function Refused({ refusal }: { refusal: Refusal | null }) {
  return refusal ? (
    <Callout tone={refusal.tone} title={refusal.title} role="alert">
      {refusal.detail}
    </Callout>
  ) : null;
}

function asideNote(me: Me): string {
  const aside = (parseCash(me.balances.cash) ?? 0n) - (parseCash(me.balances.cashAvailable) ?? 0n);
  return aside > 0n
    ? ` Another ${showCash(aside)} ${QUOTE} is set aside for open buy orders and cannot leave until they fill or are cancelled.`
    : '';
}

function Deposit({ me }: { me: Me }) {
  const api = useApi();
  const refresh = useRefreshSession();
  const id = useId();
  const [amount, setAmount] = useState('');
  const [deliveries, setDeliveries] = useState('1');
  const { cents, issue } = checkAmount(amount, MAX_DEPOSIT_CENTS, '10,000.00');
  const deposit = useMutation({
    mutationFn: () =>
      api.deposit({ amount: formatCash(cents ?? 0n), deliveries: Number(deliveries) }),
    onSettled: refresh,
  });
  const refusal = deposit.isError
    ? describeCashError(deposit.error, 'deposit', asideNote(me))
    : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (cents !== null && !deposit.isPending) deposit.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <AmountField
        id={id}
        value={amount}
        onChange={setAmount}
        issue={issue ?? (refusal?.field === 'amount' ? refusal.detail : null)}
        hint={
          <>
            up to <Num>10,000.00</Num>, ten an hour
          </>
        }
      />
      <div>
        <p className="mb-2 text-sm text-ink-2">
          How many times should the simulated payment provider deliver the same event?
        </p>
        <Segmented
          label="Number of deliveries"
          value={deliveries}
          onChange={setDeliveries}
          options={DELIVERY_CHOICES.map((n) => ({
            value: String(n),
            label: n === 1 ? 'Once' : `${n} at once`,
          }))}
        />
        <p className="mt-2 text-sm text-ink-3">
          There is no real provider. The server plays one and sends the event to its own webhook.
          However many copies arrive, the deposit must be credited once.
        </p>
      </div>
      <Button type="submit" variant="brand" disabled={cents === null || deposit.isPending}>
        {deposit.isPending ? 'Delivering…' : `Deposit${cents ? ` ${showCash(cents)}` : ''}`}
      </Button>
      {refusal && refusal.field !== 'amount' && <Refused refusal={refusal} />}
      {deposit.data && <DeliveryLog result={deposit.data} />}
    </form>
  );
}

function Done({
  result,
  verb,
  onReceipt,
}: {
  result: MovementResult;
  verb: string;
  onReceipt: () => void;
}) {
  return (
    <Callout
      tone="success"
      title={
        <>
          {verb} <Num>{showCash(result.amount)}</Num> {QUOTE}
        </>
      }
      role="status"
    >
      Your cash is now <Num>{showCash(result.cashBalance)}</Num>.{' '}
      <LinkButton onClick={onReceipt}>Receipt</LinkButton>
    </Callout>
  );
}

function Withdraw({ me }: { me: Me }) {
  const api = useApi();
  const refresh = useRefreshSession();
  const receipt = useReceipt();
  const id = useId();
  const [amount, setAmount] = useState('');
  const clientId = useRef(newClientId());
  const { cents, issue } = checkAmount(amount, MAX_MOVEMENT_CENTS, '1,000,000.00');
  const free = parseCash(me.balances.cashAvailable);
  const aside = (parseCash(me.balances.cash) ?? 0n) - (free ?? 0n);
  const withdraw = useMutation({
    mutationFn: () => api.withdraw({ clientId: clientId.current, amount: formatCash(cents ?? 0n) }),
    onSuccess: () => {
      clientId.current = newClientId();
      setAmount('');
    },
    onSettled: refresh,
  });
  const refusal = withdraw.isError
    ? describeCashError(withdraw.error, 'withdrawal', asideNote(me))
    : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (cents !== null && !withdraw.isPending) withdraw.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <AmountField
        id={id}
        value={amount}
        onChange={(next) => {
          setAmount(next);
          clientId.current = newClientId();
        }}
        issue={
          issue ?? (refusal?.field === 'amount' ? `${refusal.title}. ${refusal.detail}` : null)
        }
        hint={
          <LinkButton onClick={() => free !== null && setAmount(formatCash(free))}>
            all you can: <Num>{showCash(free)}</Num>
          </LinkButton>
        }
      />
      {aside > 0n && (
        <p className="text-sm text-ink-2">
          <Num>{showCash(aside)}</Num> of your <Num>{showCash(me.balances.cash)}</Num> is set aside
          for{' '}
          <Popover>
            <PopoverTrigger asChild>
              <LinkButton>open buy orders</LinkButton>
            </PopoverTrigger>
            <PopoverContent>
              <SetAsideList me={me} unit="USD" />
            </PopoverContent>
          </Popover>{' '}
          and cannot be withdrawn until they fill or are cancelled.
        </p>
      )}
      <p className="text-sm text-ink-3">
        Play money goes nowhere real: a withdrawal simply leaves this account.
      </p>
      <Button type="submit" variant="brand" disabled={cents === null || withdraw.isPending}>
        {withdraw.isPending ? 'Withdrawing…' : `Withdraw${cents ? ` ${showCash(cents)}` : ''}`}
      </Button>
      {refusal && refusal.field !== 'amount' && <Refused refusal={refusal} />}
      {withdraw.data && (
        <Done
          result={withdraw.data}
          verb="Withdrew"
          onReceipt={() => receipt.open(withdraw.data.clientId)}
        />
      )}
    </form>
  );
}

function Send({ me }: { me: Me }) {
  const api = useApi();
  const refresh = useRefreshSession();
  const receipt = useReceipt();
  const ids = { amount: useId(), handle: useId() };
  const [amount, setAmount] = useState('');
  const [handle, setHandle] = useState('');
  const clientId = useRef(newClientId());
  const clean = handle.trim().toLowerCase().replaceAll(' ', '');
  const wellFormed = HANDLE_PATTERN.test(clean);
  const { cents, issue } = checkAmount(amount, MAX_MOVEMENT_CENTS, '1,000,000.00');
  const lookup = useQuery({
    queryKey: ['recipient', clean],
    queryFn: () => api.lookupRecipient(clean),
    enabled: wellFormed,
    retry: false,
    staleTime: 60_000,
  });
  const send = useMutation({
    mutationFn: () =>
      api.transfer({
        clientId: clientId.current,
        amount: formatCash(cents ?? 0n),
        toHandle: clean,
      }),
    onSuccess: () => {
      clientId.current = newClientId();
      setAmount('');
    },
    onSettled: refresh,
  });
  const lookupRefusal = lookup.isError ? describeCashError(lookup.error, 'lookup') : null;
  const refusal = send.isError ? describeCashError(send.error, 'transfer', asideNote(me)) : null;
  const handleIssue =
    clean !== '' && !wellFormed
      ? 'A handle is exactly ten characters, using 0–9 and a–f.'
      : lookupRefusal && lookup.error instanceof ApiError
        ? `${lookupRefusal.title}. ${lookupRefusal.detail}`
        : refusal?.field === 'recipient'
          ? `${refusal.title}. ${refusal.detail}`
          : null;
  const recipient = lookup.data;
  const ready = cents !== null && recipient !== undefined && !send.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) send.mutate();
  };
  const edit =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      clientId.current = newClientId();
    };
  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-4 text-sm text-ink-2">
          <label htmlFor={ids.handle}>Their handle</label>
          <span>ten characters, 0–9 and a–f</span>
        </div>
        <div
          className={cn(
            'flex h-19 items-center rounded-field border-[length:var(--border-field)] border-field bg-surface px-6 focus-within:shadow-focus',
            handleIssue && 'border-danger',
          )}
        >
          <input
            id={ids.handle}
            value={handle}
            onChange={(event) => edit(setHandle)(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="3f6c2c1e9b"
            maxLength={14}
            aria-invalid={Boolean(handleIssue)}
            className="num min-w-0 flex-1 bg-transparent text-xl font-semibold outline-none placeholder:font-normal placeholder:text-ink-3 focus-visible:shadow-none"
          />
        </div>
        {handleIssue && (
          <p className="mt-2 text-sm text-danger" role="alert">
            {handleIssue}
          </p>
        )}
        {wellFormed && lookup.isPending && (
          <p className="mt-2 text-sm text-ink-3">Looking up that handle…</p>
        )}
        {recipient && (
          <p
            className="mt-2 flex items-baseline gap-4 rounded-field border border-line bg-well px-5 py-3 text-md"
            role="status"
          >
            <span className="text-sm text-ink-3">Goes to</span>
            <b className="min-w-0 flex-1 truncate font-semibold" title={recipient.displayName}>
              {recipient.displayName}
            </b>
            <Num className="text-sm text-ink-3">{groupHandle(recipient.handle)}</Num>
          </p>
        )}
      </div>
      <AmountField
        id={ids.amount}
        value={amount}
        onChange={edit(setAmount)}
        issue={
          issue ?? (refusal?.field === 'amount' ? `${refusal.title}. ${refusal.detail}` : null)
        }
        hint={
          <>
            you can use <Num>{showCash(me.balances.cashAvailable)}</Num>
          </>
        }
      />
      {ready && recipient && cents !== null && (
        <Callout tone="plain">
          Sends <Num className="font-semibold">{showCash(cents)}</Num> {QUOTE} to{' '}
          <b className="font-semibold">{recipient.displayName}</b> now. It cannot be undone from
          here.
        </Callout>
      )}
      <Button type="submit" variant="brand" disabled={!ready}>
        {send.isPending ? 'Sending…' : `Send${cents ? ` ${showCash(cents)}` : ''}`}
      </Button>
      {refusal && refusal.field === 'form' && <Refused refusal={refusal} />}
      {send.data && (
        <Done result={send.data} verb="Sent" onReceipt={() => receipt.open(send.data.clientId)} />
      )}
      <div className="flex flex-wrap items-center gap-4 border-t border-line pt-4 text-sm text-ink-2">
        To be sent cash, give someone your handle:{' '}
        <Num className="text-md font-semibold text-ink">{groupHandle(me.handle)}</Num>
        <CopyButton text={me.handle} label="Copy handle" className="border border-line-strong" />
      </div>
    </form>
  );
}

export function CashPanel({ me, className }: { me: Me; className?: string }) {
  const [params, setParams] = useSearchParams();
  const requested = params.get('cash');
  const mode: Mode = requested === 'withdraw' || requested === 'send' ? requested : 'deposit';
  const change = (next: string) => {
    const copy = new URLSearchParams(params);
    copy.set('cash', next);
    setParams(copy, { replace: true });
  };
  return (
    <Panel title="Move cash" className={className}>
      <Tabs value={mode} onValueChange={change} className="px-7 pb-7">
        <TabsList>
          <TabsTrigger value="deposit">Deposit</TabsTrigger>
          <TabsTrigger value="withdraw">Withdraw</TabsTrigger>
          <TabsTrigger value="send">Send to a person</TabsTrigger>
        </TabsList>
        <TabsContent value="deposit" className="mt-5">
          <Deposit me={me} />
        </TabsContent>
        <TabsContent value="withdraw" className="mt-5">
          <Withdraw me={me} />
        </TabsContent>
        <TabsContent value="send" className="mt-5">
          <Send me={me} />
        </TabsContent>
      </Tabs>
    </Panel>
  );
}
