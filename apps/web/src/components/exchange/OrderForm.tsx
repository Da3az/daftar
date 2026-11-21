import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { CASH_SCALE, QUANTITY_SCALE, formatCash, toMinor } from '@/lib/money';
import {
  affordableQuantity,
  enterAsGuest,
  placeOrder,
  portionOf,
  trimQuantity,
  useRefreshExchange,
  valueOf,
  type Me,
  type MarketSnapshot,
  type OrderType,
  type Side,
} from '@/lib/exchange';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorNote,
  Field,
  Input,
} from '@/components/ui/primitives';
import { cn } from '@/lib/cn';

const PORTIONS = [25, 50, 75, 100] as const;

/**
 * The order ticket — or, for a visitor with no session, the way in.
 *
 * Validation here is a courtesy: it stops a request that would certainly be
 * refused and says why next to the field. It decides nothing. The server
 * re-checks the lot, the tick, the band and the funds under the market lock,
 * and its answer is the one shown when the two disagree.
 */
export function OrderForm({
  snapshot,
  me,
  pickedPrice,
}: {
  snapshot: MarketSnapshot | undefined;
  me: Me | null | undefined;
  /** A price clicked in the book. Changes identity on every click. */
  pickedPrice: { price: string } | null;
}): React.JSX.Element {
  const refresh = useRefreshExchange();

  const [side, setSide] = useState<Side>('buy');
  const [type, setType] = useState<OrderType>('limit');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  // A click in the book fills the price and implies a limit order.
  useEffect(() => {
    if (pickedPrice === null) return;
    setPrice(pickedPrice.price);
    setType('limit');
  }, [pickedPrice]);

  const enter = useMutation({ mutationFn: enterAsGuest, onSuccess: refresh });

  const submit = useMutation({
    mutationFn: () =>
      placeOrder({ side, type, quantity, ...(type === 'limit' ? { limitPrice: price } : {}) }),
    onSuccess: async ({ order, fills }) => {
      const filled = trimQuantity(order.filledQuantity);
      setNotice(
        fills.length === 0
          ? `Order resting at ${formatCash(order.limitPrice ?? '0')}.`
          : order.status === 'filled'
            ? `Filled ${filled} ${order.symbol} in ${String(fills.length)} trade${fills.length === 1 ? '' : 's'}.`
            : order.status === 'open'
              ? `Filled ${filled} ${order.symbol}; the rest is resting.`
              : `Filled ${filled} ${order.symbol}; the rest was cancelled (${order.cancelReason ?? 'unfilled'}).`,
      );
      setQuantity('');
      await refresh();
    },
    onError: () => setNotice(null),
  });

  if (me === null) {
    return (
      <Card>
        <CardHeader title="Trade" hint="No sign-up. One click." />
        <CardBody className="space-y-3">
          <p className="text-ink-300 text-sm">
            Enter as a guest and you are handed <span className="num">$10,000.00</span> of play
            money to trade against the bots and anyone else who is here.
          </p>
          <Button
            variant="primary"
            className="w-full"
            disabled={enter.isPending}
            onClick={() => enter.mutate()}
          >
            {enter.isPending ? 'Opening your account…' : 'Enter as guest'}
          </Button>
          {enter.error !== null && (
            <ErrorNote>
              {enter.error instanceof ApiError && enter.error.status === 429
                ? 'Too many guest accounts from this address. Try again later.'
                : enter.error.message}
            </ErrorNote>
          )}
          <p className="text-ink-500 text-xs">
            Your session is a cookie on this browser. Clear it and the account is gone for good.
          </p>
        </CardBody>
      </Card>
    );
  }

  const market = snapshot?.market;
  const symbol = market?.symbol ?? '';
  const bestAsk = snapshot?.book.asks[0]?.price ?? null;
  const bestBid = snapshot?.book.bids[0]?.price ?? null;

  /** The price an estimate is made at: the limit, or the touch for a market order. */
  const referencePrice =
    type === 'limit' ? price : ((side === 'buy' ? bestAsk : bestBid) ?? market?.lastPrice ?? '');

  const quantityMinor = toMinor(quantity, QUANTITY_SCALE);
  const lot = market ? toMinor(market.lotSize, QUANTITY_SCALE) : null;
  const priceMinor = toMinor(price, CASH_SCALE);
  const minPrice = market ? toMinor(market.minPrice, CASH_SCALE) : null;
  const maxPrice = market ? toMinor(market.maxPrice, CASH_SCALE) : null;

  const quantityError =
    quantity.length === 0
      ? null
      : quantityMinor === null || quantityMinor <= 0n
        ? 'Enter a positive quantity.'
        : lot !== null && quantityMinor % lot !== 0n
          ? `Must be a multiple of ${trimQuantity(market?.lotSize ?? '')}.`
          : null;

  const priceError =
    type !== 'limit' || price.length === 0
      ? null
      : priceMinor === null || priceMinor <= 0n
        ? 'Enter a price with at most two decimals.'
        : minPrice !== null && maxPrice !== null && (priceMinor < minPrice || priceMinor > maxPrice)
          ? `Between ${formatCash(market?.minPrice ?? '')} and ${formatCash(market?.maxPrice ?? '')}.`
          : null;

  const estimate =
    quantityError === null && quantity.length > 0 && referencePrice.length > 0
      ? valueOf(quantity, referencePrice)
      : null;

  const ready =
    me !== undefined &&
    market !== undefined &&
    quantity.length > 0 &&
    quantityError === null &&
    (type === 'market' || (price.length > 0 && priceError === null));

  const fill = (percent: number): void => {
    if (!me || !market) return;
    const next =
      side === 'buy'
        ? affordableQuantity(me.balances.cashAvailable, referencePrice, market.lotSize, percent)
        : portionOf(me.balances.assetAvailable, market.lotSize, percent);
    if (next !== null) setQuantity(trimQuantity(next).replaceAll(',', ''));
  };

  const error = submit.error;

  return (
    <Card>
      <CardHeader title="Place an order" hint={me ? me.participant.displayName : ' '} />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-2 gap-1">
          <Toggle active={side === 'buy'} tone="buy" onClick={() => setSide('buy')}>
            Buy
          </Toggle>
          <Toggle active={side === 'sell'} tone="sell" onClick={() => setSide('sell')}>
            Sell
          </Toggle>
        </div>

        <div className="grid grid-cols-2 gap-1">
          <Toggle active={type === 'limit'} onClick={() => setType('limit')}>
            Limit
          </Toggle>
          <Toggle active={type === 'market'} onClick={() => setType('market')}>
            Market
          </Toggle>
        </div>

        {type === 'limit' ? (
          <Field label="Price (USD)" {...(priceError === null ? {} : { error: priceError })}>
            <Input
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              inputMode="decimal"
              spellCheck={false}
              placeholder={market?.lastPrice ?? '0.00'}
            />
          </Field>
        ) : (
          <p className="text-ink-400 text-xs">
            Fills at the best prices resting on the book, right now. Whatever cannot be filled is
            cancelled, never left resting.
          </p>
        )}

        <Field
          label={`Quantity (${symbol})`}
          {...(quantityError === null ? {} : { error: quantityError })}
        >
          <Input
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            inputMode="decimal"
            spellCheck={false}
            placeholder="0.00"
          />
        </Field>

        <div className="grid grid-cols-4 gap-1">
          {PORTIONS.map((percent) => (
            <Button key={percent} size="sm" variant="ghost" onClick={() => fill(percent)}>
              {percent}%
            </Button>
          ))}
        </div>

        <dl className="border-ink-800 space-y-1.5 border-t pt-3 text-xs">
          <Line label={type === 'limit' ? 'Total' : 'Estimated total'}>
            {estimate === null ? '—' : `${type === 'market' ? '≈ ' : ''}${formatCash(estimate)}`}
          </Line>
          <Line label="Available cash">{me ? formatCash(me.balances.cashAvailable) : '—'}</Line>
          <Line label={`Available ${symbol}`}>
            {me ? trimQuantity(me.balances.assetAvailable) : '—'}
          </Line>
        </dl>

        <Button
          variant={side === 'buy' ? 'primary' : 'danger'}
          className="w-full"
          disabled={!ready || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? 'Placing…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${symbol}`}
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
      </CardBody>
    </Card>
  );
}

function Toggle({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone?: 'buy' | 'sell';
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'h-8 rounded-md text-sm font-medium transition-colors',
        !active && 'bg-ink-900 text-ink-400 hover:text-ink-100',
        active && tone === undefined && 'bg-ink-700 text-ink-50',
        active && tone === 'buy' && 'bg-credit/20 text-credit',
        active && tone === 'sell' && 'bg-debit/20 text-debit',
      )}
    >
      {children}
    </button>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-400">{label}</dt>
      <dd className="num text-ink-100">{children}</dd>
    </div>
  );
}
