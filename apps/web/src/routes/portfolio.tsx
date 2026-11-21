import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  CASH_SCALE,
  compareDecimal,
  formatCash,
  formatTimestamp,
  fromMinor,
  toMinor,
} from '@/lib/money';
import {
  getFills,
  getOrders,
  leave,
  trimQuantity,
  useMarketSnapshot,
  useMe,
  useRefreshExchange,
  valueOf,
} from '@/lib/exchange';
import { ActivityFeed } from '@/components/exchange/ActivityFeed';
import { CashPanel } from '@/components/exchange/CashPanel';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Empty,
  SkeletonRows,
  Table,
  Td,
  TdNum,
  Th,
  ThNum,
} from '@/components/ui/primitives';

export const Route = createFileRoute('/portfolio')({ component: Portfolio });

/** What the guest holds, what it is worth, and everything they have done. */
function Portfolio(): React.JSX.Element {
  const me = useMe();
  const snapshot = useMarketSnapshot();
  const refresh = useRefreshExchange();

  const signedIn = me.data !== null && me.data !== undefined;

  const orders = useQuery({
    queryKey: ['exchange', 'orders'],
    queryFn: getOrders,
    enabled: signedIn,
    staleTime: 0,
    refetchInterval: 5_000,
  });

  const fills = useQuery({
    queryKey: ['exchange', 'fills'],
    queryFn: getFills,
    enabled: signedIn,
    staleTime: 0,
    refetchInterval: 5_000,
  });

  const exit = useMutation({ mutationFn: leave, onSuccess: refresh });

  if (me.data === null) {
    return (
      <Card>
        <CardBody>
          <p className="text-ink-300 text-sm">
            You have no account on this browser yet.{' '}
            <Link to="/" className="text-accent underline">
              Enter as a guest
            </Link>{' '}
            on the Trade page to get one.
          </p>
        </CardBody>
      </Card>
    );
  }

  const account = me.data;
  const lastPrice = snapshot.data?.market.lastPrice;

  // Cash, plus the position marked at the last traded price. All in BigInt
  // minor units; the strings are only parsed here and formatted below.
  const positionValue =
    account && lastPrice !== undefined ? valueOf(account.balances.asset, lastPrice) : null;
  const cashMinor = account ? toMinor(account.balances.cash, CASH_SCALE) : null;
  const positionMinor = positionValue === null ? null : toMinor(positionValue, CASH_SCALE);
  /*
   * What the guest has put in, net — not the fixed opening balance. Measured
   * against the opening balance, a deposit would read as profit and a
   * withdrawal as a loss.
   */
  const contributedMinor = account ? toMinor(account.netContributed, CASH_SCALE) : null;

  const equity =
    cashMinor === null || positionMinor === null
      ? null
      : fromMinor(cashMinor + positionMinor, CASH_SCALE);
  const profit =
    cashMinor === null || positionMinor === null || contributedMinor === null
      ? null
      : fromMinor(cashMinor + positionMinor - contributedMinor, CASH_SCALE);
  const profitTone =
    profit === null
      ? 'text-ink-100'
      : compareDecimal(profit, '0.00', CASH_SCALE) > 0
        ? 'text-credit'
        : compareDecimal(profit, '0.00', CASH_SCALE) < 0
          ? 'text-debit'
          : 'text-ink-100';

  const symbol = account?.symbol ?? '';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-ink-50 text-lg font-semibold">Portfolio</h1>
          <p className="text-ink-400 text-xs">{account?.participant.displayName ?? ' '}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={exit.isPending}
          onClick={() => {
            // There is no way back: the cookie is the only key to this account.
            if (window.confirm('Leave this guest account? It cannot be recovered.')) exit.mutate();
          }}
        >
          Leave this account
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Equity" hint="Cash plus position at the last trade">
          {equity === null ? '—' : formatCash(equity)}
        </Figure>
        <Figure
          label="Profit / loss"
          hint={`Against ${formatCash(account?.netContributed ?? '0')} put in, net`}
        >
          <span className={profitTone}>{profit === null ? '—' : formatCash(profit)}</span>
        </Figure>
        <Figure
          label="Cash"
          hint={`${account ? formatCash(account.balances.cashAvailable) : '—'} available`}
        >
          {account ? formatCash(account.balances.cash) : '—'}
        </Figure>
        <Figure
          label={`${symbol} held`}
          hint={`${account ? trimQuantity(account.balances.assetAvailable) : '—'} available`}
        >
          {account ? trimQuantity(account.balances.asset) : '—'}
        </Figure>
      </div>

      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        {account && <CashPanel me={account} />}
        <ActivityFeed enabled={signedIn} />
      </div>

      <Card>
        <CardHeader title="Trades" hint="Every fill, from either side of the book." />
        <Table>
          <thead>
            <tr>
              <Th>Time (UTC)</Th>
              <Th>Side</Th>
              <Th>Role</Th>
              <ThNum>Price</ThNum>
              <ThNum>Quantity</ThNum>
              <ThNum>Value</ThNum>
            </tr>
          </thead>
          <tbody>
            {fills.isPending && signedIn && <SkeletonRows columns={6} />}
            {fills.data?.fills.map((fill) => (
              <tr key={`${fill.tradeId}-${fill.liquidity}`}>
                <Td className="text-ink-400 text-xs">{formatTimestamp(fill.createdAt)}</Td>
                <Td>
                  <Badge tone={fill.side === 'buy' ? 'credit' : 'debit'}>{fill.side}</Badge>
                </Td>
                <Td className="text-ink-400 text-xs">{fill.liquidity}</Td>
                <TdNum>{formatCash(fill.price)}</TdNum>
                <TdNum>{trimQuantity(fill.quantity)}</TdNum>
                <TdNum>{formatCash(fill.notional)}</TdNum>
              </tr>
            ))}
          </tbody>
        </Table>
        {fills.data?.fills.length === 0 && <Empty>No trades yet.</Empty>}
      </Card>

      <Card>
        <CardHeader title="Orders" hint="The most recent hundred, in any state." />
        <Table>
          <thead>
            <tr>
              <Th>Placed (UTC)</Th>
              <Th>Side</Th>
              <Th>Type</Th>
              <ThNum>Price</ThNum>
              <ThNum>Quantity</ThNum>
              <ThNum>Filled</ThNum>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {orders.isPending && signedIn && <SkeletonRows columns={7} />}
            {orders.data?.orders.map((order) => (
              <tr key={order.clientOrderId}>
                <Td className="text-ink-400 text-xs">
                  {order.createdAt === undefined ? '—' : formatTimestamp(order.createdAt)}
                </Td>
                <Td>
                  <Badge tone={order.side === 'buy' ? 'credit' : 'debit'}>{order.side}</Badge>
                </Td>
                <Td className="text-ink-400 text-xs">{order.type}</Td>
                <TdNum>{order.limitPrice === null ? 'market' : formatCash(order.limitPrice)}</TdNum>
                <TdNum>{trimQuantity(order.quantity)}</TdNum>
                <TdNum>{trimQuantity(order.filledQuantity)}</TdNum>
                <Td>
                  <Badge
                    tone={
                      order.status === 'open'
                        ? 'accent'
                        : order.status === 'filled'
                          ? 'neutral'
                          : 'warn'
                    }
                  >
                    {order.status}
                  </Badge>
                  {order.cancelReason !== null && (
                    <span className="text-ink-500 ml-2 text-xs">{order.cancelReason}</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {orders.data?.orders.length === 0 && <Empty>No orders yet.</Empty>}
      </Card>
    </div>
  );
}

function Figure({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card>
      <CardBody>
        <p className="text-ink-400 text-xs">{label}</p>
        <p className="num text-ink-50 mt-1 text-xl font-semibold">{children}</p>
        <p className="text-ink-500 mt-1 text-xs">{hint}</p>
      </CardBody>
    </Card>
  );
}
