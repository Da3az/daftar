import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { getTransactions, type Transaction } from '@/lib/api';
import {
  CASH_SCALE,
  CASH_UNIT,
  QUANTITY_SCALE,
  formatByUnit,
  formatCash,
  formatQuantity,
  formatTimestamp,
  toMinor,
} from '@/lib/money';
import { useCurrentAccount } from '@/lib/account-store';
import { AccountPicker } from '@/components/AccountPicker';
import {
  Badge,
  Button,
  Card,
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

export const Route = createFileRoute('/transactions')({ component: Transactions });

function Transactions(): React.JSX.Element {
  const account = useCurrentAccount();

  /**
   * Cursor history as a stack, so "previous" works without re-deriving it.
   *
   * Keyset pagination is one-directional by nature — a cursor says "give me
   * what is after this" and has no inverse. Keeping the cursors that were used
   * is how a Back button becomes possible at all; computing a reverse cursor
   * would mean a second query ordered the other way.
   */
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;

  const [expanded, setExpanded] = useState<string | null>(null);

  const page = useQuery({
    queryKey: ['transactions', account, cursor],
    queryFn: () =>
      getTransactions(account, { limit: 25, ...(cursor === null ? {} : { before: cursor }) }),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-ink-50 text-lg font-semibold">Transactions</h1>
          <p className="text-ink-400 text-xs">
            Expand a row to see <strong>every</strong> leg. They sum to zero per unit.
          </p>
        </div>
        <AccountPicker />
      </div>

      {page.isError && <ErrorNote>Could not load transactions for {account}.</ErrorNote>}

      <Card>
        <CardHeader
          title="Ledger transactions"
          hint="Newest first. Paginated by cursor, not OFFSET."
          actions={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={cursors.length === 1}
                onClick={() => setCursors((stack) => stack.slice(0, -1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                disabled={page.data?.nextCursor === null || page.data === undefined}
                onClick={() =>
                  setCursors((stack) =>
                    page.data?.nextCursor === undefined || page.data.nextCursor === null
                      ? stack
                      : [...stack, page.data.nextCursor],
                  )
                }
              >
                Next
              </Button>
            </div>
          }
        />

        <Table>
          <thead>
            <tr>
              <Th className="w-8" />
              <Th>When</Th>
              <Th>Transaction</Th>
              <Th>Kind</Th>
              <Th>Order</Th>
              <Th>Idempotency key</Th>
              <Th>Settled by</Th>
              <ThNum>Legs</ThNum>
            </tr>
          </thead>
          <tbody>
            {page.isPending && <SkeletonRows columns={8} rows={8} />}

            {page.data?.transactions.length === 0 && (
              <tr>
                <Td colSpan={8}>
                  <Empty>No transactions on this account.</Empty>
                </Td>
              </tr>
            )}

            {page.data?.transactions.map((transaction) => (
              <TransactionRow
                key={transaction.id}
                transaction={transaction}
                expanded={expanded === transaction.id}
                onToggle={() =>
                  setExpanded((current) => (current === transaction.id ? null : transaction.id))
                }
              />
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function TransactionRow({
  transaction,
  expanded,
  onToggle,
}: {
  transaction: Transaction;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  /**
   * Sum the legs per unit, in the browser, from the strings the API sent.
   *
   * This is the one place the UI does arithmetic on money, and it does it on
   * **minor units as BigInt** via `toMinor` — never by parsing a float — so
   * the displayed "sums to zero" claim is itself exact.
   *
   * Recomputing it client-side rather than trusting a server-provided boolean
   * is deliberate: the claim is checkable by the reader, from the same numbers
   * printed in the table.
   */
  const sums = new Map<string, bigint>();
  for (const leg of transaction.legs) {
    // `toMinor` with the scale the leg's own unit has — cash is 2 digits, an
    // asset quantity is 8. Stripping the decimal point by hand would add
    // amounts of different scales together and produce a nonsense total that
    // happened to be non-zero.
    const minor = toMinor(leg.amount, leg.unit === CASH_UNIT ? CASH_SCALE : QUANTITY_SCALE);
    if (minor === null) continue;
    sums.set(leg.unit, (sums.get(leg.unit) ?? 0n) + minor);
  }
  const balanced = sums.size > 0 && [...sums.values()].every((sum) => sum === 0n);

  return (
    <>
      <tr className="hover:bg-ink-900/60 cursor-pointer" onClick={onToggle}>
        <Td>
          <ChevronRight
            className={`text-ink-500 size-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
            aria-hidden
          />
        </Td>
        <Td className="text-ink-400 whitespace-nowrap text-xs">
          {formatTimestamp(transaction.createdAt)}
        </Td>
        <Td className="num text-xs">{transaction.id}</Td>
        <Td>
          <Badge tone={transaction.kind === 'funding' ? 'credit' : 'neutral'}>
            {transaction.kind}
          </Badge>
        </Td>
        <Td className="num text-xs">
          {transaction.order === null ? (
            <span className="text-ink-600">—</span>
          ) : (
            <>
              {transaction.order.side} {formatQuantity(transaction.order.quantity)}{' '}
              {transaction.order.symbol}
              <span className="text-ink-500 ml-2">@ {formatCash(transaction.order.price)}</span>
            </>
          )}
        </Td>
        <Td className="num text-xs">
          {transaction.order?.idempotencyKey ?? (
            <span className="text-ink-600" title="No Idempotency-Key was sent with this order">
              none
            </span>
          )}
        </Td>
        <Td className="text-xs">
          {transaction.webhookEvent === null ? (
            <span className="text-ink-600">—</span>
          ) : (
            <Link
              to="/settlements"
              className="text-accent num underline"
              onClick={(event) => event.stopPropagation()}
            >
              {transaction.webhookEvent.idempotencyKey}
            </Link>
          )}
        </Td>
        <TdNum className="text-xs">{transaction.legs.length}</TdNum>
      </tr>

      {expanded && (
        <tr>
          <Td colSpan={8} className="bg-ink-950/60 p-0">
            <div className="px-10 py-4">
              <Table>
                <thead>
                  <tr>
                    <Th>Account</Th>
                    <Th>Kind</Th>
                    <Th>Direction</Th>
                    <Th>Unit</Th>
                    <ThNum>Amount</ThNum>
                  </tr>
                </thead>
                <tbody>
                  {transaction.legs.map((leg, index) => (
                    <tr key={`${leg.accountExternalId}-${String(index)}`}>
                      <Td className="num text-xs">{leg.accountExternalId}</Td>
                      <Td className="text-ink-400 text-xs">{leg.accountKind}</Td>
                      <Td>
                        <Badge tone={leg.direction === 'credit' ? 'credit' : 'debit'}>
                          {leg.direction}
                        </Badge>
                      </Td>
                      <Td className="text-ink-400 text-xs">{leg.unit}</Td>
                      <TdNum className={leg.direction === 'credit' ? 'text-credit' : 'text-debit'}>
                        {formatByUnit(leg.amount, leg.unit)}
                      </TdNum>
                    </tr>
                  ))}
                </tbody>
              </Table>

              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                <Badge tone={balanced ? 'credit' : 'debit'}>
                  {balanced ? 'legs sum to zero' : 'UNBALANCED'}
                </Badge>
                {[...sums.entries()].map(([unit, sum]) => (
                  <span key={unit} className="text-ink-500 num">
                    {unit}: {sum.toString()}
                  </span>
                ))}
                <span className="text-ink-600">
                  summed in the browser from the amounts above, as integers
                </span>
              </div>
            </div>
          </Td>
        </tr>
      )}
    </>
  );
}
