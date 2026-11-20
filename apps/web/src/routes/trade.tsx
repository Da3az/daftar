import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, listInstruments, placeOrder, type Order } from '@/lib/api';
import {
  QUANTITY_SCALE,
  estimateNotional,
  formatCash,
  formatQuantity,
  isPositiveAmount,
} from '@/lib/money';
import { useCurrentAccount } from '@/lib/account-store';
import { useTickers } from '@/lib/prices';
import { AccountPicker } from '@/components/AccountPicker';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorNote,
  Field,
  Input,
  Select,
  Table,
  Td,
  TdNum,
  Th,
} from '@/components/ui/primitives';

export const Route = createFileRoute('/trade')({ component: Trade });

const MODES = ['serializable', 'advisory', 'pessimistic'] as const;

function Trade(): React.JSX.Element {
  const account = useCurrentAccount();
  const queryClient = useQueryClient();
  const { tickers } = useTickers();

  const instruments = useQuery({ queryKey: ['instruments'], queryFn: listInstruments });

  const [symbol, setSymbol] = useState('BTC');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [quantity, setQuantity] = useState('0.01000000');
  const [mode, setMode] = useState<(typeof MODES)[number]>('serializable');
  const [useIdempotencyKey, setUseIdempotencyKey] = useState(true);
  const [placed, setPlaced] = useState<Order | null>(null);

  const instrument = instruments.data?.find((i) => i.symbol === symbol);
  const live = tickers[symbol];

  const quantityValid = isPositiveAmount(quantity, QUANTITY_SCALE);
  const estimate =
    instrument === undefined || !quantityValid
      ? null
      : estimateNotional(quantity, instrument.referencePrice);

  const submit = useMutation({
    mutationFn: async () => {
      /*
       * `externalId` is generated here, per submission.
       *
       * It is the order's natural key and a UNIQUE index enforces it, so a
       * double-click produces a 409 rather than two orders. That is a weaker
       * guarantee than the Idempotency-Key below — a 409 tells the client
       * "something already exists" rather than returning the original
       * result — which is exactly why both exist.
       */
      const externalId = `web-${crypto.randomUUID()}`;

      return placeOrder(
        { externalId, accountId: account, symbol, side, quantity },
        {
          concurrencyMode: mode,
          /*
           * The key is derived from the generated order id, so a retry of
           * *this* submission replays the original response, while a new
           * submission gets a new key and places a new order. A key derived
           * from the form fields would make two deliberate identical orders
           * impossible to place.
           */
          ...(useIdempotencyKey ? { idempotencyKey: `web-order-${externalId}` } : {}),
        },
      );
    },
    onSuccess: (order) => {
      setPlaced(order);
      // Both the positions card and the transaction list are now stale.
      void queryClient.invalidateQueries({ queryKey: ['positions', account] });
      void queryClient.invalidateQueries({ queryKey: ['transactions', account] });
      void queryClient.invalidateQueries({ queryKey: ['statement', account] });
    },
  });

  const error = submit.error;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-ink-50 text-lg font-semibold">Trade</h1>
          <p className="text-ink-400 text-xs">
            Account <span className="num">{account}</span>
          </p>
        </div>
        <AccountPicker />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Place an order"
            hint="Four ledger entries across two units, in one transaction."
          />
          <CardBody className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Asset">
                <Select value={symbol} onChange={(event) => setSymbol(event.target.value)}>
                  {instruments.data?.map((i) => (
                    <option key={i.symbol} value={i.symbol}>
                      {i.symbol} — {i.displayName}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Side">
                <Select
                  value={side}
                  onChange={(event) => setSide(event.target.value as 'buy' | 'sell')}
                >
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                </Select>
              </Field>
            </div>

            <Field
              label="Quantity"
              hint={`Exact decimal, up to ${String(QUANTITY_SCALE)} fractional digits.`}
              {...(quantity.length > 0 && !quantityValid
                ? { error: 'Must be a positive exact decimal with at most 8 decimal places.' }
                : {})}
            >
              <Input
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                inputMode="decimal"
                spellCheck={false}
              />
            </Field>

            <Field
              label="Concurrency strategy"
              hint="All three are correct; they trade throughput against failure mode."
            >
              <Select
                value={mode}
                onChange={(event) => setMode(event.target.value as (typeof MODES)[number])}
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>

            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={useIdempotencyKey}
                onChange={(event) => setUseIdempotencyKey(event.target.checked)}
                className="accent-accent mt-0.5"
              />
              <span className="text-ink-300">
                Send an <span className="num">Idempotency-Key</span>
                <span className="text-ink-500 block">
                  With it, a retry returns the original response. Without it, the UNIQUE index on
                  the order id turns a retry into a 409 instead.
                </span>
              </span>
            </label>

            <div className="border-ink-800 space-y-2 border-t pt-3">
              {/*
               * The estimate is labelled as computed from the frozen reference
               * price, and the live price is shown beside it. This is the one
               * place in the interface where confusing the two would cost a
               * user money, so both are named explicitly.
               */}
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-ink-400">Estimated cost</span>
                <span className="num text-ink-50 font-medium">
                  {estimate === null ? '—' : formatCash(estimate)}
                </span>
              </div>
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-ink-500">at frozen reference price</span>
                <span className="num text-ink-400">
                  {instrument === undefined ? '—' : formatCash(instrument.referencePrice)}
                </span>
              </div>
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-ink-500">live market price (not used)</span>
                <span className="num text-ink-500">
                  {live === undefined ? '—' : formatCash(live.lastPrice)}
                </span>
              </div>
            </div>

            <Button
              variant="primary"
              className="w-full"
              disabled={!quantityValid || submit.isPending || instrument === undefined}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? 'Placing…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${symbol}`}
            </Button>

            {error !== null && (
              <ErrorNote>
                {error instanceof ApiError ? (
                  <>
                    <span className="num">{error.code}</span> — {error.message}
                    {error.code === 'insufficient_funds' && (
                      <span className="mt-1 block text-xs">
                        The ledger refused this rather than allowing an overdraft. That refusal is
                        the feature.
                      </span>
                    )}
                  </>
                ) : (
                  error.message
                )}
              </ErrorNote>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Result"
            hint="The pending entry this order produced, as the server recorded it."
          />
          <CardBody>
            {placed === null ? (
              <p className="text-ink-500 text-sm">
                No order placed in this session yet. The result shown here is the server&apos;s
                response verbatim, including how many attempts the ledger write took.
              </p>
            ) : (
              <dl className="space-y-2 text-sm">
                <Row label="Status">
                  <Badge tone="warn">{placed.status}</Badge>
                </Row>
                <Row label="Order id">
                  <span className="num text-xs">{placed.externalId}</span>
                </Row>
                <Row label="Ledger transaction">
                  <span className="num text-xs">{placed.transactionId}</span>
                </Row>
                <Row label="Quantity">
                  <span className="num">{formatQuantity(placed.quantity, placed.symbol)}</span>
                </Row>
                <Row label="Frozen price">
                  <span className="num">{formatCash(placed.price)}</span>
                </Row>
                <Row label="Notional">
                  <span className="num">{formatCash(placed.notional)}</span>
                </Row>
                <Row label="Cash after">
                  <span className="num">{formatCash(placed.cashBalanceAfter)}</span>
                </Row>
                <Row label="Position after">
                  <span className="num">
                    {formatQuantity(placed.assetBalanceAfter, placed.symbol)}
                  </span>
                </Row>
                <Row label="Ledger attempts">
                  <span className="num">
                    {placed.attempts}
                    {placed.attempts > 1 && (
                      <span className="text-ink-500 ml-2 text-xs">
                        retried — serialization conflict
                      </span>
                    )}
                  </span>
                </Row>
              </dl>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="The asset list and the prices orders are actually priced at"
          hint="Frozen in the instruments table. The order endpoint makes no network call."
        />
        <Table>
          <thead>
            <tr>
              <Th>Symbol</Th>
              <Th>Name</Th>
              <Th>Reference price (used)</Th>
              <Th>Live market price (display only)</Th>
              <Th>Frozen at</Th>
            </tr>
          </thead>
          <tbody>
            {instruments.data?.map((i) => (
              <tr key={i.symbol}>
                <Td className="font-medium">{i.symbol}</Td>
                <Td className="text-ink-400">{i.displayName}</Td>
                <TdNum className="text-left">{formatCash(i.referencePrice)}</TdNum>
                <TdNum className="text-ink-500 text-left">
                  {tickers[i.symbol] === undefined ? '—' : formatCash(tickers[i.symbol]!.lastPrice)}
                </TdNum>
                <Td className="text-ink-500 text-xs">{i.referencePriceAt}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-ink-800/60 flex items-baseline justify-between gap-4 border-b pb-2">
      <dt className="text-ink-400 text-xs">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
