import { useQuery } from '@tanstack/react-query';
import { formatCash, formatTimestamp } from '@/lib/money';
import { getActivity, trimQuantity, type ActivityEvent } from '@/lib/exchange';
import {
  Badge,
  Card,
  CardHeader,
  Empty,
  SkeletonRows,
  Table,
  Td,
  TdNum,
  Th,
  ThNum,
} from '@/components/ui/primitives';

/** What each event type is called on screen, and which way the cash went. */
const LABELS: Record<string, { label: string; tone: 'credit' | 'debit' | 'neutral' }> = {
  'trade.buy': { label: 'Bought', tone: 'debit' },
  'trade.sell': { label: 'Sold', tone: 'credit' },
  'deposit.credited': { label: 'Deposit', tone: 'credit' },
  'withdrawal.completed': { label: 'Withdrawal', tone: 'debit' },
  'transfer.sent': { label: 'Sent', tone: 'debit' },
  'transfer.received': { label: 'Received', tone: 'credit' },
};

function describe(event: ActivityEvent): string {
  if (event.quantity !== null && event.price !== null) {
    return `${trimQuantity(event.quantity)} ${event.symbol ?? ''} at ${formatCash(event.price)}${
      event.liquidity === null ? '' : ` · ${event.liquidity}`
    }`;
  }
  if (event.counterparty !== null) {
    return `${event.type === 'transfer.sent' ? 'to' : 'from'} ${event.counterparty}`;
  }
  return '';
}

/** Milliseconds between the money moving and the feed hearing about it. */
function lagOf(event: ActivityEvent): string {
  const lag = Date.parse(event.publishedAt) - Date.parse(event.occurredAt);
  if (!Number.isFinite(lag) || lag < 0) return '—';
  return lag < 1_000 ? `${String(Math.round(lag))} ms` : `${(lag / 1_000).toFixed(1)} s`;
}

/**
 * The guest's activity feed.
 *
 * Nothing writes this list directly. Each row is an event that was committed in
 * the same database transaction as the money it describes and delivered here
 * afterwards by a background worker — so the list can be behind, and says by
 * how much, but cannot be missing a row.
 */
export function ActivityFeed({ enabled }: { enabled: boolean }): React.JSX.Element {
  const activity = useQuery({
    queryKey: ['exchange', 'activity'],
    queryFn: getActivity,
    enabled,
    staleTime: 0,
    refetchInterval: 2_000,
  });

  const pending = activity.data?.pending ?? 0;

  return (
    <Card>
      <CardHeader
        title="Activity"
        hint="Every movement of your cash, delivered by the outbox worker."
        actions={
          <Badge tone={pending > 0 ? 'warn' : 'neutral'}>
            {pending > 0 ? `${String(pending)} waiting to be delivered` : 'up to date'}
          </Badge>
        }
      />
      <Table>
        <thead>
          <tr>
            <Th>Time (UTC)</Th>
            <Th>Event</Th>
            <Th>Detail</Th>
            <ThNum>Amount</ThNum>
            <ThNum>Delivered after</ThNum>
          </tr>
        </thead>
        <tbody>
          {activity.isPending && enabled && <SkeletonRows columns={5} />}
          {activity.data?.events.map((event) => {
            const known = LABELS[event.type];
            return (
              <tr key={event.id}>
                <Td className="text-ink-400 text-xs">{formatTimestamp(event.occurredAt)}</Td>
                <Td>
                  <Badge tone={known?.tone ?? 'neutral'}>{known?.label ?? event.type}</Badge>
                </Td>
                <Td className="text-ink-400 text-xs">{describe(event)}</Td>
                <TdNum>{event.amount === null ? '—' : formatCash(event.amount)}</TdNum>
                <TdNum className="text-ink-500 text-xs">{lagOf(event)}</TdNum>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {activity.data?.events.length === 0 && (
        <Empty>
          {pending > 0
            ? 'Events are committed and waiting; the worker has not delivered them yet.'
            : 'Nothing yet.'}
        </Empty>
      )}
    </Card>
  );
}
