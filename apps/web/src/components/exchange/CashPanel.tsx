import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { CASH_SCALE, formatCash, toMinor } from '@/lib/money';
import {
  deposit,
  sendTransfer,
  useRefreshExchange,
  withdraw,
  type DepositResult,
  type Me,
} from '@/lib/exchange';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorNote,
  Field,
  Input,
  Select,
} from '@/components/ui/primitives';
import { cn } from '@/lib/cn';

type Mode = 'deposit' | 'withdraw' | 'send';

const MODES: { value: Mode; label: string }[] = [
  { value: 'deposit', label: 'Deposit' },
  { value: 'withdraw', label: 'Withdraw' },
  { value: 'send', label: 'Send' },
];

/** How many times the simulated provider can be asked to deliver one event. */
const DELIVERY_CHOICES = [1, 2, 5, 10] as const;

const HANDLE = /^[0-9a-f]{10}$/;

/**
 * Cash in, cash out, and cash to another guest.
 *
 * None of the three goes through the order book. A deposit is an event from a
 * (simulated) payment provider, delivered to the same webhook endpoint a real
 * one would call; a withdrawal and a transfer are single ledger transactions
 * that can land while an order of yours is filling.
 *
 * As everywhere in this client, validation here is a courtesy and decides
 * nothing: the server re-checks the amount, the funds and the recipient.
 */
export function CashPanel({ me }: { me: Me }): React.JSX.Element {
  const refresh = useRefreshExchange();

  const [mode, setMode] = useState<Mode>('deposit');
  const [amount, setAmount] = useState('');
  const [deliveries, setDeliveries] = useState<number>(1);
  const [toHandle, setToHandle] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [lastDeposit, setLastDeposit] = useState<DepositResult | null>(null);

  const amountMinor = toMinor(amount, CASH_SCALE);
  const amountError =
    amount.length === 0
      ? null
      : amountMinor === null || amountMinor <= 0n
        ? 'Enter a positive amount with at most two decimals.'
        : null;

  const handleError =
    mode !== 'send' || toHandle.length === 0
      ? null
      : !HANDLE.test(toHandle)
        ? 'A handle is 10 characters, 0-9 and a-f.'
        : toHandle === me.handle
          ? 'That handle is your own.'
          : null;

  const submit = useMutation({
    mutationFn: async (): Promise<void> => {
      if (mode === 'deposit') {
        const result = await deposit({ amount, deliveries });
        setLastDeposit(result);
        setNotice(
          result.credited
            ? `Deposited ${formatCash(result.amount)}.`
            : 'The provider’s event was not accepted; nothing was credited.',
        );
        return;
      }

      setLastDeposit(null);

      if (mode === 'withdraw') {
        const result = await withdraw(amount);
        setNotice(`Withdrew ${formatCash(result.amount)}.`);
        return;
      }

      const result = await sendTransfer({ amount, toHandle });
      setNotice(`Sent ${formatCash(result.amount)} to ${toHandle}.`);
    },
    onSuccess: async () => {
      setAmount('');
      await refresh();
    },
    onError: () => {
      setNotice(null);
      setLastDeposit(null);
    },
  });

  const ready =
    amount.length > 0 &&
    amountError === null &&
    (mode !== 'send' || (toHandle.length > 0 && handleError === null));

  const switchTo = (next: Mode): void => {
    setMode(next);
    setNotice(null);
    setLastDeposit(null);
    submit.reset();
  };

  const error = submit.error;

  return (
    <Card>
      <CardHeader title="Cash" hint={`${formatCash(me.balances.cashAvailable)} available`} />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-3 gap-1">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              aria-pressed={mode === m.value}
              onClick={() => switchTo(m.value)}
              className={cn(
                'h-8 rounded-md text-sm font-medium transition-colors',
                mode === m.value
                  ? 'bg-ink-700 text-ink-50'
                  : 'bg-ink-900 text-ink-400 hover:text-ink-100',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>

        <Field label="Amount (USD)" {...(amountError === null ? {} : { error: amountError })}>
          <Input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            spellCheck={false}
            placeholder="0.00"
          />
        </Field>

        {mode === 'deposit' && (
          <>
            <Field
              label="Simulate provider retries"
              hint="The payment provider sends the same event this many times, at once."
            >
              <Select
                value={String(deliveries)}
                onChange={(event) => setDeliveries(Number(event.target.value))}
              >
                {DELIVERY_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? 'Delivered once' : `Delivered ${String(n)} times`}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-ink-500 text-xs">
              Play money from a simulated provider. However many times the event arrives, it is
              credited once.
            </p>
          </>
        )}

        {mode === 'withdraw' && (
          <p className="text-ink-500 text-xs">
            Cash reserved by your open buy orders cannot be withdrawn. Cancel an order to free it.
          </p>
        )}

        {mode === 'send' && (
          <>
            <Field
              label="Recipient’s handle"
              {...(handleError === null ? {} : { error: handleError })}
            >
              <Input
                value={toHandle}
                onChange={(event) => setToHandle(event.target.value.trim().toLowerCase())}
                spellCheck={false}
                placeholder="e.g. 3f6c2c1e9b"
              />
            </Field>
            <p className="text-ink-500 text-xs">
              Your own handle is <span className="num text-ink-200">{me.handle}</span> — give it to
              another guest to be paid.
            </p>
          </>
        )}

        <Button
          variant="primary"
          className="w-full"
          disabled={!ready || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {submit.isPending
            ? 'Working…'
            : mode === 'deposit'
              ? 'Deposit'
              : mode === 'withdraw'
                ? 'Withdraw'
                : 'Send'}
        </Button>

        {error !== null && (
          <ErrorNote>
            {error instanceof ApiError ? (
              <>
                <span className="num">{error.code}</span> — {error.message}
              </>
            ) : (
              error.message
            )}
          </ErrorNote>
        )}

        {notice !== null && error === null && (
          <p className="border-credit/40 bg-credit/10 text-credit rounded border px-3 py-2 text-sm">
            {notice}
          </p>
        )}

        {lastDeposit !== null && error === null && <Deliveries result={lastDeposit} />}
      </CardBody>
    </Card>
  );
}

/** What the webhook endpoint answered to each delivery of one deposit event. */
function Deliveries({ result }: { result: DepositResult }): React.JSX.Element {
  const { summary } = result;

  return (
    <div className="border-ink-800 space-y-2 border-t pt-3 text-xs">
      <p className="text-ink-300">
        {String(result.deliveries.length)} deliver{result.deliveries.length === 1 ? 'y' : 'ies'} of
        one event: <span className="text-credit">{String(summary.processed)} processed</span>,{' '}
        {String(summary.duplicates)} answered as a duplicate
        {summary.inProgress > 0 && `, ${String(summary.inProgress)} told to retry`}
        {summary.rejected > 0 && `, ${String(summary.rejected)} rejected`}. Credited{' '}
        {result.credited ? 'once' : 'zero times'}.
      </p>
      <ul className="num text-ink-500 space-y-0.5">
        {result.deliveries.map((d, index) => (
          <li key={index}>
            #{String(d.delivery)}
            {d.retry > 0 && ` retry ${String(d.retry)}`} → {String(d.status)} {d.outcome}
          </li>
        ))}
      </ul>
    </div>
  );
}
