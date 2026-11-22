import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useApi } from '@/api/context';
import { useRefreshSession } from '@/api/queries';
import type { Fill, MarketSnapshot, Me, PlaceOrderRequest, PlaceOrderResult } from '@/api/types';
import { Button, Callout, Kbd, LinkButton, Num, type Tone } from '@/components/bits';
import { Panel } from '@/components/Panel';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Segmented } from '@/components/ui/segmented';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RecurringPanel } from './Recurring';
import { cn } from '@/lib/cn';
import { newClientId } from '@/lib/ids';
import {
  affordableQty,
  formatCash,
  formatQty,
  parseCash,
  parseQty,
  percentOf,
  showCash,
  showQty,
} from '@/lib/money';
import { QUOTE, SYMBOL } from '@/lib/rules';
import { describeGuestError, describeOrderError, type Refusal } from '../errors';
import { useEnterAsGuest } from '../GuestEntry';
import { check, estimate, type Estimate, rulesOf } from './ticketMath';
import { useTicket } from './ticketStore';
import { holdingsOf, SetAsideList } from './YourMoney';

export type Outcome =
  | { kind: 'done'; tone: Tone; title: string; detail: string }
  | { kind: 'refused'; refusal: Refusal };

function breakdown(fills: Fill[]): string {
  const byPrice = new Map<string, bigint>();
  for (const fill of fills)
    byPrice.set(fill.price, (byPrice.get(fill.price) ?? 0n) + (parseQty(fill.quantity) ?? 0n));
  return [...byPrice].map(([price, units]) => `${showQty(units)} at ${showCash(price)}`).join(', ');
}

/** Four different confirmations, and a fifth for a replay: the same order, not a second one. */
export function confirmation(result: PlaceOrderResult): Outcome {
  const { order, fills } = result;
  const verb = order.side === 'buy' ? 'Bought' : 'Sold';
  const filled = parseQty(order.filledQuantity) ?? 0n;
  const total = parseQty(order.quantity) ?? 0n;
  const left = showQty(total - filled);
  const value = showCash(fills.reduce((sum, fill) => sum + (parseCash(fill.notional) ?? 0n), 0n));
  const at = order.limitPrice ? showCash(order.limitPrice) : 'market';
  let outcome: Outcome;
  if (order.status === 'filled') {
    outcome = {
      kind: 'done',
      tone: 'success',
      title: `${verb} ${showQty(filled)} ${SYMBOL} — filled in full`,
      detail: `${breakdown(fills)}. ${order.side === 'buy' ? 'Cost' : 'Proceeds'} ${value} ${QUOTE}.`,
    };
  } else if (order.status === 'open' && filled > 0n) {
    outcome = {
      kind: 'done',
      tone: 'success',
      title: `${verb} ${showQty(filled)} ${SYMBOL}; ${left} is waiting`,
      detail: `Filled ${breakdown(fills)} for ${value} ${QUOTE}. The other ${left} waits in the book at ${at}.`,
    };
  } else if (order.status === 'cancelled' && filled > 0n) {
    const why =
      order.cancelReason === 'insufficient_funds'
        ? 'you could not cover more'
        : order.cancelReason === 'self_trade'
          ? 'the only orders left on offer were your own'
          : 'nothing more was on offer';
    outcome = {
      kind: 'done',
      tone: 'warning',
      title: `${verb} ${showQty(filled)} ${SYMBOL}; the other ${left} was cancelled`,
      detail: `Filled ${breakdown(fills)} for ${value} ${QUOTE}. The rest was cancelled because ${why} — a market order never waits.`,
    };
  } else {
    outcome = {
      kind: 'done',
      tone: 'info',
      title: `Waiting in the book: ${order.side} ${showQty(total)} ${SYMBOL} at ${at}`,
      detail: `Nothing filled yet. ${order.side === 'buy' ? 'Its cash is' : 'Its coins are'} set aside until it fills or you cancel.`,
    };
  }
  if (result.replayed && outcome.kind === 'done') {
    return {
      kind: 'done',
      tone: 'info',
      title: 'Same order — replayed',
      detail: `The server had already received this exact order, so it answered with the original result and placed nothing new. ${outcome.title}.`,
    };
  }
  return outcome;
}

function sentence(
  side: 'buy' | 'sell',
  type: 'limit' | 'market',
  price: string,
  qty: bigint,
  e: Estimate,
): string {
  const all = showQty(qty);
  const aside =
    side === 'buy'
      ? `${showCash(e.totalCents)} ${QUOTE} is set aside`
      : `${showQty(e.restUnits)} ${SYMBOL} is set aside`;
  const other = side === 'buy' ? 'seller' : 'buyer';
  if (type === 'market') {
    if (e.fillUnits === 0n)
      return `There is nobody to trade with on that side of the book right now, so a market order would be refused.`;
    const short =
      e.shortUnits > 0n
        ? ` Only ${showQty(e.fillUnits)} is on offer in the visible book; the other ${showQty(e.shortUnits)} would be cancelled, never left waiting.`
        : '';
    return `Takes the best prices in the book now: about ${showQty(e.fillUnits)} ${SYMBOL} at an average of ${e.average}, down to ${showCash(e.lastPrice)}.${short}`;
  }
  if (e.fillUnits === 0n)
    return `Your price is ${side === 'buy' ? 'below' : 'above'} every ${other}, so nothing fills now. All ${all} ${SYMBOL} waits in the book at ${showCash(price)} and ${aside} until it fills or you cancel.`;
  if (e.restUnits === 0n)
    return `Your price reaches ${other}s already in the book, so all ${all} ${SYMBOL} should fill now at an average of about ${e.average}. The book can move before your order arrives.`;
  return `About ${showQty(e.fillUnits)} ${SYMBOL} fills now at an average of ${e.average}. The other ${showQty(e.restUnits)} waits in the book at ${showCash(price)}.`;
}

function Field({
  id,
  label,
  aside,
  unit,
  value,
  onChange,
  issue,
  inputRef,
  disabled,
  flashKey,
  children,
  placeholder,
}: {
  id: string;
  label: string;
  aside?: React.ReactNode;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  issue?: string | null;
  inputRef?: React.Ref<HTMLInputElement>;
  disabled?: boolean;
  flashKey?: number;
  placeholder?: string;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-4 text-sm text-ink-2">
        <label htmlFor={id}>{label}</label>
        <span className="text-right">{aside}</span>
      </div>
      <div
        key={flashKey}
        className={cn(
          'flex h-19 items-center rounded-field border-[length:var(--border-field)] border-field bg-surface px-6 focus-within:shadow-focus',
          issue && 'border-danger',
          disabled && 'bg-well',
          flashKey ? 'animate-flash' : '',
        )}
        style={{ ['--flash-color' as string]: 'var(--color-you-wash)' }}
      >
        <input
          id={id}
          ref={inputRef}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={Boolean(issue)}
          aria-describedby={issue ? `${id}-issue` : undefined}
          className="num min-w-0 flex-1 bg-transparent text-xl font-semibold outline-none placeholder:font-normal placeholder:text-ink-3 focus-visible:shadow-none"
        />
        <span className="text-sm font-semibold text-ink-3">{unit}</span>
      </div>
      {issue && (
        <p id={`${id}-issue`} className="mt-2 text-sm text-danger">
          {issue}
        </p>
      )}
      {children}
    </div>
  );
}

const pill =
  'flex-1 whitespace-nowrap rounded-pill border border-line bg-well py-1 text-sm text-ink-2 disabled:opacity-50';

export function Ticket({
  snapshot,
  me,
  className,
  plain,
}: {
  snapshot: MarketSnapshot | undefined;
  me: Me | null | undefined;
  className?: string;
  plain?: boolean;
}) {
  const api = useApi();
  const refresh = useRefreshSession();
  const { values, set, setSide, setType, priceTaken, focusRef } = useTicket();
  const ids = { price: useId(), quantity: useId() };
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [mode, setMode] = useState<'order' | 'recurring'>('order');
  const rules = rulesOf(snapshot?.market);
  const checked = check(values, rules);
  const { side, type } = values;
  const bids = snapshot?.book.bids ?? [];
  const asks = snapshot?.book.asks ?? [];
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  const holdings = me ? holdingsOf(me, snapshot?.market.lastPrice) : null;

  // One client id per distinct order. A double click or a retry sends the same id, so it is one order.
  const intent = useRef({ key: '', id: newClientId() });
  const key = JSON.stringify(values);
  if (intent.current.key !== key) intent.current = { key, id: newClientId() };

  useEffect(() => {
    setOutcome((current) => (current?.kind === 'refused' ? null : current));
  }, [key]);

  const est = useMemo(() => {
    if (checked.qtyUnits === null || (type === 'limit' && checked.priceCents === null)) return null;
    return estimate(side, type, checked.priceCents, checked.qtyUnits, side === 'buy' ? asks : bids);
  }, [checked.qtyUnits, checked.priceCents, side, type, asks, bids]);

  const place = useMutation({
    mutationFn: (request: PlaceOrderRequest) => api.placeOrder(request, request.clientOrderId),
    onSuccess: (result) => {
      const done = confirmation(result);
      setOutcome(done);
      if (done.kind === 'done')
        (done.tone === 'warning'
          ? toast.warning
          : done.tone === 'info'
            ? toast.info
            : toast.success)(done.title, { description: done.detail });
      intent.current = { key: '', id: newClientId() };
      refresh();
    },
    onError: (error) => {
      const note =
        holdings && holdings.cashAside > 0n && side === 'buy'
          ? ` Another ${showCash(holdings.cashAside)} ${QUOTE} is set aside for open orders.`
          : holdings && holdings.coinAside > 0n && side === 'sell'
            ? ` Another ${showQty(holdings.coinAside)} ${SYMBOL} is set aside for open orders.`
            : '';
      setOutcome({ kind: 'refused', refusal: describeOrderError(error, note) });
      refresh();
    },
  });

  const enter = useEnterAsGuest();

  const ready = checked.qtyUnits !== null && (type === 'market' || checked.priceCents !== null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (me === null) {
      enter.mutate();
      return;
    }
    if (!me || !ready || place.isPending || checked.qtyUnits === null) return;
    const quantity = formatQty(checked.qtyUnits);
    const clientOrderId = intent.current.id;
    place.mutate(
      type === 'limit' && checked.priceCents !== null
        ? {
            type: 'limit',
            clientOrderId,
            side,
            quantity,
            limitPrice: formatCash(checked.priceCents),
          }
        : { type: 'market', clientOrderId, side, quantity },
    );
  };

  const fraction = (percent: number) => {
    if (!holdings) return;
    if (side === 'sell') {
      set({
        quantity: showQty(percentOf(holdings.coinFree, percent, rules.lot)).replaceAll(',', ''),
      });
      return;
    }
    const price = type === 'limit' ? checked.priceCents : parseCash(bestAsk);
    if (price === null) return;
    set({
      quantity: showQty(
        affordableQty(percentOf(holdings.cashFree, percent, 1n), price, rules.lot),
      ).replaceAll(',', ''),
    });
  };
  const middle = (): string | undefined => {
    const bid = parseCash(bestBid);
    const ask = parseCash(bestAsk);
    if (bid === null || ask === null) return undefined;
    const sum = bid + ask;
    return formatCash(side === 'buy' ? sum / 2n : (sum + 1n) / 2n);
  };

  const over =
    est && holdings
      ? side === 'buy'
        ? est.totalCents > holdings.cashFree
        : (checked.qtyUnits ?? 0n) > holdings.coinFree
      : false;
  const refusal = outcome?.kind === 'refused' ? outcome.refusal : null;
  const guestRefusal = enter.isError ? describeGuestError(enter.error) : null;
  const totalLabel = est?.exact
    ? 'Total, exact'
    : side === 'buy'
      ? 'Estimated cost'
      : 'Estimated proceeds';
  const sideName = side === 'buy' ? 'Buy' : 'Sell';

  return (
    <Panel title="Place an order" className={className} id="ticket" plain={plain}>
      {me && (
        <div className="px-7 pb-4">
          <Tabs value={mode} onValueChange={(next) => setMode(next as 'order' | 'recurring')}>
            <TabsList aria-label="One order or a recurring buy">
              <TabsTrigger value="order">One order</TabsTrigger>
              <TabsTrigger value="recurring">Recurring</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}
      {mode === 'recurring' && me ? (
        <RecurringPanel />
      ) : (
        <form
          id="ticket-form"
          onSubmit={submit}
          className="flex flex-col gap-4 px-7 pb-6"
          noValidate
        >
          <Segmented
            size="lg"
            label="Buy or sell"
            value={side}
            onChange={setSide}
            options={[
              {
                value: 'buy',
                label: 'Buy',
                selectedClass: 'data-[state=on]:bg-buy data-[state=on]:text-on-buy',
              },
              {
                value: 'sell',
                label: 'Sell',
                selectedClass: 'data-[state=on]:bg-sell data-[state=on]:text-on-sell',
              },
            ]}
          />
          <Tabs value={type} onValueChange={(next) => setType(next as 'limit' | 'market')}>
            <TabsList aria-label="Order type">
              <TabsTrigger value="limit">Limit — name your price</TabsTrigger>
              <TabsTrigger value="market">Market — take the best</TabsTrigger>
            </TabsList>
          </Tabs>

          <Field
            id={ids.price}
            label="Price per coin"
            unit={QUOTE}
            value={type === 'market' ? '' : values.price}
            placeholder={
              type === 'market'
                ? `≈ ${showCash(side === 'buy' ? bestAsk : bestBid)}, set by the book`
                : '0.00'
            }
            disabled={type === 'market'}
            onChange={(price) => set({ price })}
            issue={
              type === 'limit'
                ? (checked.priceIssue ?? (refusal?.field === 'price' ? refusal.detail : null))
                : null
            }
            inputRef={focusRef}
            flashKey={priceTaken}
            aside={
              <>
                Best {side === 'buy' ? 'ask' : 'bid'} is{' '}
                <Num>{showCash(side === 'buy' ? bestAsk : bestBid)}</Num>
              </>
            }
          >
            <div className="mt-3 flex gap-3">
              <button
                type="button"
                className={pill}
                disabled={type === 'market' || !bestBid}
                onClick={() => bestBid && set({ price: bestBid })}
              >
                Bid <span className="num">{showCash(bestBid)}</span>
              </button>
              <button
                type="button"
                className={pill}
                disabled={type === 'market' || !middle()}
                onClick={() => {
                  const m = middle();
                  if (m) set({ price: m });
                }}
              >
                Mid <span className="num">{showCash(middle())}</span>
              </button>
              <button
                type="button"
                className={pill}
                disabled={type === 'market' || !bestAsk}
                onClick={() => bestAsk && set({ price: bestAsk })}
              >
                Ask <span className="num">{showCash(bestAsk)}</span>
              </button>
            </div>
          </Field>

          <Field
            id={ids.quantity}
            label="How many coins"
            unit={SYMBOL}
            value={values.quantity}
            placeholder="0.00"
            onChange={(quantity) => set({ quantity })}
            issue={checked.quantityIssue}
            aside={
              <>
                in steps of <Num>{showQty(rules.lot)}</Num>
              </>
            }
          >
            <div className="mt-3 flex gap-3">
              {[25, 50, 75, 100].map((percent) => (
                <button
                  key={percent}
                  type="button"
                  className={cn(pill, 'num')}
                  disabled={!holdings}
                  onClick={() => fraction(percent)}
                  aria-label={`${percent}% of what you can use`}
                >
                  {percent}%
                </button>
              ))}
            </div>
          </Field>

          {est && checked.qtyUnits !== null && (
            <Callout tone={side}>
              {sentence(side, type, values.price, checked.qtyUnits, est)}
            </Callout>
          )}
          {over && !refusal && (
            <Callout tone="warning">
              That is more than you can use (
              {side === 'buy' ? (
                <>
                  <Num>{showCash(holdings?.cashFree)}</Num> {QUOTE}
                </>
              ) : (
                <>
                  <Num>{showQty(holdings?.coinFree)}</Num> {SYMBOL}
                </>
              )}
              ). You can still send it; the server decides.
            </Callout>
          )}

          <div className="flex items-baseline justify-between text-md text-ink-2">
            <span>{totalLabel}</span>
            <b className="num text-xl font-semibold text-ink">
              {est ? showCash(est.totalCents) : '—'} <span className="text-md">{QUOTE}</span>
            </b>
          </div>

          {me === null ? (
            <>
              <Button type="submit" size="lg" variant="brand" disabled={enter.isPending}>
                <span>
                  {enter.isPending ? 'Creating your account…' : 'Enter as guest to trade'}
                </span>
              </Button>
              {guestRefusal ? (
                <Callout tone={guestRefusal.tone} title={guestRefusal.title} role="alert">
                  {guestRefusal.detail}
                </Callout>
              ) : (
                <p className="text-sm text-ink-2">
                  One click hands you <Num className="font-semibold">10,000.00</Num> of play money.
                  No sign-up. Your session is a cookie on this browser — clear it and the account is
                  gone for good.
                </p>
              )}
            </>
          ) : (
            <Button
              type="submit"
              size="lg"
              variant={side}
              disabled={!me || !ready || place.isPending}
              aria-busy={place.isPending}
            >
              <span>
                {place.isPending
                  ? 'Sending — counted once'
                  : `${sideName}${checked.qtyUnits ? ` ${showQty(checked.qtyUnits)}` : ''} ${SYMBOL}`}
              </span>
              <Kbd>Ctrl ↵</Kbd>
            </Button>
          )}

          {refusal && refusal.field !== 'price' && (
            <Callout tone={refusal.tone} title={refusal.title} role="alert">
              {refusal.detail}
            </Callout>
          )}
          {outcome?.kind === 'done' && (
            <Callout tone={outcome.tone} title={outcome.title} role="status">
              {outcome.detail}{' '}
              <LinkButton tone="ink" onClick={() => setOutcome(null)}>
                Dismiss
              </LinkButton>
            </Callout>
          )}

          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm text-ink-2">
            <span>
              You can use{' '}
              <Num className="text-ink">{holdings ? showCash(holdings.cashFree) : '—'}</Num> {QUOTE}{' '}
              · <Num className="text-ink">{holdings ? showQty(holdings.coinFree) : '—'}</Num>{' '}
              {SYMBOL}
            </span>
            {me &&
              holdings &&
              (side === 'buy' ? holdings.cashAside > 0n : holdings.coinAside > 0n) && (
                <Popover>
                  <PopoverTrigger asChild>
                    <LinkButton>
                      <Num>
                        {side === 'buy'
                          ? showCash(holdings.cashAside)
                          : showQty(holdings.coinAside)}
                      </Num>{' '}
                      more is set aside
                    </LinkButton>
                  </PopoverTrigger>
                  <PopoverContent align="end">
                    <SetAsideList me={me} unit={side === 'buy' ? 'USD' : 'DFT'} />
                  </PopoverContent>
                </Popover>
              )}
          </div>
          <p className="text-xs text-ink-3">
            Prices in steps of {showCash(rules.tick)}, from {showCash(rules.min)} to{' '}
            {showCash(rules.max)}. Up to 100,000 coins an order, 50 open orders. The server checks
            every order again and its answer wins.
          </p>
        </form>
      )}
    </Panel>
  );
}
