import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getStatement } from '@/lib/api';
import {
  CASH_SCALE,
  CASH_UNIT,
  QUANTITY_SCALE,
  formatByUnit,
  formatTimestamp,
  fromMinor,
  microseconds,
  toMinor,
} from '@/lib/money';
import { useCurrentAccount } from '@/lib/account-store';
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

export const Route = createFileRoute('/ledger')({ component: AccountLedger });

function AccountLedger(): React.JSX.Element {
  const account = useCurrentAccount();

  const statement = useQuery({
    queryKey: ['statement', account],
    queryFn: () => getStatement(account, 200),
  });

  const unit = statement.data?.account.unit ?? CASH_UNIT;
  const scale = unit === CASH_UNIT ? CASH_SCALE : QUANTITY_SCALE;

  // Column totals, computed as integers from the same strings in the table.
  let debitTotal = 0n;
  let creditTotal = 0n;
  for (const row of statement.data?.rows ?? []) {
    const minor = toMinor(row.amount, scale);
    if (minor === null) continue;
    if (minor < 0n) debitTotal += -minor;
    else creditTotal += minor;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-ink-50 text-lg font-semibold">Account ledger</h1>
          <p className="text-ink-400 text-xs">
            T-account for <span className="num">{account}</span>
            {statement.data !== undefined && (
              <>
                {' '}
                · <span className="num">{statement.data.account.kind}</span> ·{' '}
                <span className="num">{unit}</span>
              </>
            )}
          </p>
        </div>
        <AccountPicker />
      </div>

      {statement.isError && <ErrorNote>No account {account}.</ErrorNote>}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardBody>
            <p className="text-ink-400 text-xs">Total debits</p>
            <p className="num text-debit mt-1 text-xl font-semibold">
              {formatByUnit(fromMinor(debitTotal, scale), unit)}
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-ink-400 text-xs">Total credits</p>
            <p className="num text-credit mt-1 text-xl font-semibold">
              {formatByUnit(fromMinor(creditTotal, scale), unit)}
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-ink-400 text-xs">Closing balance</p>
            <p className="num text-ink-50 mt-1 text-xl font-semibold">
              {statement.data === undefined || statement.data.rows.length === 0
                ? '—'
                : formatByUnit(statement.data.rows.at(-1)!.runningBalance, unit)}
            </p>
            <p className="text-ink-600 mt-1 text-[11px]">
              credits − debits, which is the running balance of the last row
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Entries"
          hint="Ordered by (created_at, id). The id tiebreaker is what makes the running balance deterministic."
        />
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Entry</Th>
              <Th>Transaction</Th>
              <Th>Kind</Th>
              <ThNum>Debit</ThNum>
              <ThNum>Credit</ThNum>
              <ThNum>Running balance</ThNum>
            </tr>
          </thead>
          <tbody>
            {statement.isPending && <SkeletonRows columns={7} rows={10} />}

            {statement.data?.rows.length === 0 && (
              <tr>
                <Td colSpan={7}>
                  <Empty>No entries on this account yet.</Empty>
                </Td>
              </tr>
            )}

            {statement.data?.rows.map((row) => {
              const micro = microseconds(row.createdAt);

              return (
                <tr key={row.entryId}>
                  <Td className="text-ink-400 whitespace-nowrap text-xs">
                    {formatTimestamp(row.createdAt)}
                    {/*
                     * The microsecond tail, shown because it is the reason the
                     * `id` tiebreaker in the ORDER BY is necessary: a four-leg
                     * order writes every entry with one `now()`, so these are
                     * identical across the legs of a transaction and
                     * `created_at` alone cannot order them.
                     */}
                    {micro !== null && <span className="text-ink-700">{micro}µs</span>}
                  </Td>
                  <Td className="num text-ink-500 text-xs">{row.entryId}</Td>
                  <Td className="num text-xs">{row.transactionId}</Td>
                  <Td>
                    <Badge tone={row.transactionKind === 'funding' ? 'credit' : 'neutral'}>
                      {row.transactionKind}
                    </Badge>
                  </Td>

                  {/*
                   * Debits and credits in separate columns — that is what makes
                   * it a T-account rather than a list of signed numbers. The
                   * sign lives in the column, so the amount is shown unsigned.
                   */}
                  <TdNum className="text-debit">
                    {row.direction === 'debit'
                      ? formatByUnit(row.amount.replace('-', ''), row.unit)
                      : ''}
                  </TdNum>
                  <TdNum className="text-credit">
                    {row.direction === 'credit' ? formatByUnit(row.amount, row.unit) : ''}
                  </TdNum>
                  <TdNum className="text-ink-200">
                    {formatByUnit(row.runningBalance, row.unit)}
                  </TdNum>
                </tr>
              );
            })}
          </tbody>
        </Table>

        <div className="border-ink-800 text-ink-500 border-t px-4 py-2 text-xs">
          Capped at 200 entries. The busiest seeded account has around 17,000 and the house shards
          have about 2.5 million each — an unbounded list here would be a multi-second scan.
        </div>
      </Card>
    </div>
  );
}
