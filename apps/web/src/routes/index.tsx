import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getPositions, getTransactions, listInstruments } from '@/lib/api';
import { formatCash, formatQuantity, formatTimestamp } from '@/lib/money';
import { useCurrentAccount } from '@/lib/account-store';
import { useTickers, type FeedStatus } from '@/lib/prices';
import { PriceChart } from '@/components/PriceChart';
import { AccountPicker } from '@/components/AccountPicker';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  Empty,
  ErrorNote,
  SkeletonRows,
  Table,
  Td,
  TdNum,
  Th,
  ThNum,
} from '@/components/ui/primitives';

export const Route = createFileRoute('/')({ component: Dashboard });

function Dashboard(): React.JSX.Element {
  const account = useCurrentAccount();
  const { tickers, status } = useTickers();

  const positions = useQuery({
    queryKey: ['positions', account],
    queryFn: () => getPositions(account),
  });

  const instruments = useQuery({ queryKey: ['instruments'], queryFn: listInstruments });

  const activity = useQuery({
    queryKey: ['transactions', account, 'recent'],
    queryFn: () => getTransactions(account, { limit: 8 }),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-ink-50 text-lg font-semibold">Dashboard</h1>
          <p className="text-ink-400 text-xs">
            Account <span className="num">{account}</span>
          </p>
        </div>
        <AccountPicker />
      </div>

      {positions.isError && (
        <ErrorNote>
          Could not load <span className="num">{account}</span> — check the id, or confirm the API
          is running on port 3000.
        </ErrorNote>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader
            title="Cash"
            hint="Settled balance. There is no pending-cash concept here — see below."
          />
          <CardBody>
            {positions.isPending ? (
              <span className="bg-ink-800 block h-8 w-40 animate-pulse rounded" />
            ) : (
              <p className="num text-ink-50 text-3xl font-semibold">
                {formatCash(positions.data?.cash ?? '0.00')}
              </p>
            )}

            {/*
             * An honest note instead of a fabricated "pending" figure.
             *
             * The brief asks for "cash available vs pending". This ledger has
             * no pending state for cash: an order debits the customer and
             * credits the house in **one transaction**, so the money has either
             * moved or it has not. Showing a pending row that is always zero
             * would imply a settlement pipeline that does not exist, and
             * inventing one would be the kind of decorative feature that makes
             * a reader distrust the numbers that are real.
             */}
            <dl className="border-ink-800 mt-4 space-y-2 border-t pt-3 text-xs">
              <div className="flex items-baseline justify-between">
                <dt className="text-ink-400">Pending</dt>
                <dd className="text-ink-500">
                  n/a — cash moves in one transaction, so there is no pending state
                </dd>
              </div>
              <div className="flex items-baseline justify-between">
                <dt className="text-ink-400">Orders</dt>
                <dd className="text-ink-300">
                  recorded <span className="num">pending</span> until a settlement webhook arrives
                </dd>
              </div>
            </dl>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="BTC / USDT"
            hint="Live market data, display only. Orders use the frozen reference price."
            actions={<FeedBadge status={status} />}
          />
          <PriceChart symbol="BTC" />
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Positions"
          hint="Cost basis is derived from this account's buy orders, not from the ledger."
        />
        <Table>
          <thead>
            <tr>
              <Th>Asset</Th>
              <ThNum>Quantity</ThNum>
              <ThNum>Avg cost</ThNum>
              <ThNum>Reference price</ThNum>
              <ThNum>Live price</ThNum>
              <ThNum>Value at reference</ThNum>
            </tr>
          </thead>
          <tbody>
            {positions.isPending && <SkeletonRows columns={6} rows={3} />}

            {positions.data?.positions.length === 0 && (
              <tr>
                <Td colSpan={6}>
                  <Empty>
                    No positions. Place an order on the <Link to="/trade">Trade</Link> page.
                  </Empty>
                </Td>
              </tr>
            )}

            {positions.data?.positions.map((position) => {
              const live = tickers[position.symbol];
              const instrument = instruments.data?.find((i) => i.symbol === position.symbol);

              return (
                <tr key={position.symbol}>
                  <Td>
                    <span className="font-medium">{position.symbol}</span>
                    {instrument !== undefined && (
                      <span className="text-ink-500 ml-2 text-xs">{instrument.displayName}</span>
                    )}
                  </Td>
                  <TdNum>{formatQuantity(position.quantity)}</TdNum>
                  <TdNum>
                    {position.costBasis === null ? (
                      // Not "$0.00". Zero cost basis and unknown cost basis are
                      // different facts, and a position that arrived by funding
                      // rather than purchase has no cost basis at all.
                      <span className="text-ink-600">unknown</span>
                    ) : (
                      formatCash(position.costBasis)
                    )}
                  </TdNum>
                  <TdNum>{formatCash(position.referencePrice)}</TdNum>
                  <TdNum>
                    {live === undefined ? (
                      <span className="text-ink-600">—</span>
                    ) : (
                      <span className="text-ink-400">{formatCash(live.lastPrice)}</span>
                    )}
                  </TdNum>
                  <TdNum>{formatCash(position.marketValue)}</TdNum>
                </tr>
              );
            })}
          </tbody>
        </Table>

        <div className="border-ink-800 text-ink-500 border-t px-4 py-2 text-xs">
          Reference price and live price differ, and the difference is not a bug — the reference
          price is frozen in the database so that order amounts and every benchmark in{' '}
          <Link to="/evidence" className="underline">
            docs/evidence
          </Link>{' '}
          are reproducible.
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Recent activity"
          hint="Every row is one ledger transaction. Expand them on the Transactions page."
          actions={
            <Link to="/transactions" className="text-accent text-xs underline">
              All transactions
            </Link>
          }
        />
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Kind</Th>
              <Th>Order</Th>
              <ThNum>Quantity</ThNum>
              <ThNum>Notional</ThNum>
              <ThNum>Legs</ThNum>
            </tr>
          </thead>
          <tbody>
            {activity.isPending && <SkeletonRows columns={6} rows={4} />}

            {activity.data?.transactions.length === 0 && (
              <tr>
                <Td colSpan={6}>
                  <Empty>No activity yet.</Empty>
                </Td>
              </tr>
            )}

            {activity.data?.transactions.map((transaction) => (
              <tr key={transaction.id}>
                <Td className="text-ink-400 whitespace-nowrap text-xs">
                  {formatTimestamp(transaction.createdAt)}
                </Td>
                <Td>
                  <Badge tone={transaction.kind === 'funding' ? 'credit' : 'neutral'}>
                    {transaction.kind}
                  </Badge>
                </Td>
                <Td className="num text-xs">
                  {transaction.order?.externalId ?? <span className="text-ink-600">—</span>}
                </Td>
                <TdNum className="text-xs">
                  {transaction.order === null
                    ? '—'
                    : formatQuantity(transaction.order.quantity, transaction.order.symbol)}
                </TdNum>
                <TdNum className="text-xs">
                  {transaction.order === null ? '—' : formatCash(transaction.order.notional)}
                </TdNum>
                <TdNum className="text-xs">{transaction.legs.length}</TdNum>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function FeedBadge({ status }: { status: FeedStatus }): React.JSX.Element {
  // Each state says what it means operationally. "unavailable" explicitly
  // reassures, because a visitor in a geo-blocked region should not conclude
  // the application is broken.
  const map: Record<FeedStatus, { tone: 'credit' | 'warn' | 'neutral'; label: string }> = {
    connecting: { tone: 'neutral', label: 'connecting' },
    live: { tone: 'credit', label: 'live stream' },
    polling: { tone: 'warn', label: 'REST fallback' },
    unavailable: { tone: 'warn', label: 'feed blocked — display only anyway' },
  };

  const { tone, label } = map[status];
  return <Badge tone={tone}>{label}</Badge>;
}
