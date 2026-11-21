import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, X, Zap } from 'lucide-react';
import {
  ApiError,
  createChaosSession,
  fireBurst,
  type BurstResult,
  type ChaosProfile,
} from '@/lib/api';
import { CASH_SCALE, formatCash, fromMinor } from '@/lib/money';
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
  ThNum,
} from '@/components/ui/primitives';

export const Route = createFileRoute('/lab/chaos')({ component: ChaosPanel });

/** The six profiles, grouped so the correct and broken ones are not adjacent. */
const PROFILES: { value: string; label: string; profile: ChaosProfile; group: string }[] = [
  {
    value: 'order:advisory',
    label: 'advisory locks',
    profile: { kind: 'order', mode: 'advisory' },
    group: 'Correct — the real order path',
  },
  {
    value: 'order:serializable',
    label: 'serializable + retry',
    profile: { kind: 'order', mode: 'serializable' },
    group: 'Correct — the real order path',
  },
  {
    value: 'order:pessimistic',
    label: 'pessimistic row locks',
    profile: { kind: 'order', mode: 'pessimistic' },
    group: 'Correct — the real order path',
  },
  {
    value: 'debit:guarded_atomic',
    label: 'guarded atomic debit',
    profile: { kind: 'debit', strategy: 'guarded_atomic' },
    group: 'Correct — single-leg debit',
  },
  {
    value: 'debit:naive_overdraft',
    label: 'naive — no overdraft guard',
    profile: { kind: 'debit', strategy: 'naive_overdraft' },
    group: 'Deliberately broken',
  },
  {
    value: 'debit:naive_lost_update',
    label: 'naive — read-modify-write',
    profile: { kind: 'debit', strategy: 'naive_lost_update' },
    group: 'Deliberately broken',
  },
];

function ChaosPanel(): React.JSX.Element {
  const [selected, setSelected] = useState('debit:naive_lost_update');
  const [virtualUsers, setVirtualUsers] = useState(60);
  const [accountSpread, setAccountSpread] = useState(1);
  const [history, setHistory] = useState<BurstResult[]>([]);

  /**
   * The token is fetched once and reused for the session's lifetime.
   *
   * Not per burst: the session endpoint is rate-limited to 10/minute and a
   * token lasts 15 minutes, so fetching one per burst would exhaust the limit
   * long before the burst limit bit — and the error would point at the wrong
   * endpoint.
   */
  const session = useQuery({
    queryKey: ['chaos-session'],
    queryFn: createChaosSession,
    staleTime: 10 * 60_000,
    retry: 0,
  });

  const profile = PROFILES.find((p) => p.value === selected)?.profile;

  const burst = useMutation({
    mutationFn: () => {
      if (session.data === undefined || profile === undefined) {
        throw new Error('no session');
      }
      return fireBurst(session.data.token, { profile, virtualUsers, accountSpread });
    },
    onSuccess: (result) => setHistory((current) => [result, ...current].slice(0, 6)),
  });

  const limits = session.data?.limits;
  const latest = history[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-ink-50 text-lg font-semibold">Chaos panel</h1>
        <p className="text-ink-400 text-xs">
          Fires real concurrent ledger writes, server-side, against a private demo tenant.
        </p>
      </div>

      <Card>
        <CardBody className="text-ink-400 space-y-2 text-xs">
          <p>
            <strong className="text-ink-200">The concurrency happens in the server.</strong> A
            browser caps at 6 connections per origin on HTTP/1.1 and runs one JavaScript thread, so
            firing 200 <span className="num">fetch</span> calls from this page would be a queue of 6
            — the database would see six overlapping transactions, every invariant would hold, and
            this panel would be showing the ledger surviving load that never happened.
          </p>
          <p>
            Every write lands in a per-session demo tenant
            {session.data !== undefined && (
              <>
                {' '}
                (<span className="num text-ink-300">{session.data.tenant}</span>)
              </>
            )}
            , so a burst that deliberately overdraws cannot touch the seeded data the benchmarks
            were measured against.
          </p>
        </CardBody>
      </Card>

      {session.isError && (
        <ErrorNote>
          Could not get a burst token.{' '}
          {session.error instanceof ApiError && session.error.status === 429
            ? 'Rate-limited — the session endpoint allows 10 per minute.'
            : 'Is the API running?'}
        </ErrorNote>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Settings" hint="Caps are enforced server-side." />
          <CardBody className="space-y-4">
            <Field label="Strategy or naive flag">
              <Select value={selected} onChange={(event) => setSelected(event.target.value)}>
                {[
                  'Correct — the real order path',
                  'Correct — single-leg debit',
                  'Deliberately broken',
                ].map((group) => (
                  <optgroup key={group} label={group}>
                    {PROFILES.filter((p) => p.group === group).map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>

            <Field
              label="Concurrent virtual users"
              hint={`Server cap: ${String(limits?.maxVirtualUsers ?? 200)}.`}
            >
              <Input
                type="number"
                min={1}
                max={limits?.maxVirtualUsers ?? 200}
                value={virtualUsers}
                onChange={(event) => setVirtualUsers(Number(event.target.value))}
              />
            </Field>

            <Field
              label="Account spread"
              hint={`How many accounts the load is spread over. Server cap: ${String(limits?.maxAccountSpread ?? 50)}.`}
            >
              <Input
                type="number"
                min={1}
                max={limits?.maxAccountSpread ?? 50}
                value={accountSpread}
                onChange={(event) => setAccountSpread(Number(event.target.value))}
              />
            </Field>

            <p className="text-ink-500 text-[11px]">
              Spread of 1 puts every request on one row, which is the contention profile that made
              Phase 3&apos;s prediction wrong. Spreading it out is what restores throughput.
            </p>

            <Button
              variant="primary"
              className="w-full"
              disabled={session.data === undefined || burst.isPending}
              onClick={() => burst.mutate()}
            >
              <Zap className="size-4" aria-hidden />
              {burst.isPending ? 'Firing…' : 'Fire burst'}
            </Button>

            {burst.error !== null && (
              <ErrorNote>
                {burst.error instanceof ApiError && burst.error.status === 429
                  ? 'Rate-limited — the burst endpoint allows 6 per minute, because one burst is up to 200 concurrent transactions.'
                  : burst.error.message}
              </ErrorNote>
            )}
          </CardBody>
        </Card>

        <div className="space-y-6 lg:col-span-2">
          {latest === undefined ? (
            <Card>
              <CardBody>
                <p className="text-ink-500 text-sm">
                  No burst fired yet. Try <strong>naive — read-modify-write</strong> with 60 users
                  on 1 account, then the same settings with <strong>advisory locks</strong>.
                </p>
              </CardBody>
            </Card>
          ) : (
            <Results result={latest} />
          )}
        </div>
      </div>

      {history.length > 1 && (
        <Card>
          <CardHeader title="This session's runs" hint="Most recent first." />
          <Table>
            <thead>
              <tr>
                <Th>Profile</Th>
                <ThNum>Users</ThNum>
                <ThNum>Spread</ThNum>
                <ThNum>Succeeded</ThNum>
                <ThNum>Refused</ThNum>
                <ThNum>Errored</ThNum>
                <ThNum>Attempts</ThNum>
                <ThNum>ops/s</ThNum>
                <Th>Invariants</Th>
              </tr>
            </thead>
            <tbody>
              {history.map((run, index) => (
                <tr key={index}>
                  <Td className="num text-xs">{describe(run.profile)}</Td>
                  <TdNum className="text-xs">{run.virtualUsers}</TdNum>
                  <TdNum className="text-xs">{run.accountSpread}</TdNum>
                  <TdNum className="text-xs">{run.succeeded}</TdNum>
                  <TdNum className="text-xs">{run.refused}</TdNum>
                  <TdNum className="text-xs">{run.errored}</TdNum>
                  <TdNum className="text-xs">{run.totalAttempts}</TdNum>
                  <TdNum className="text-xs">{run.throughput}</TdNum>
                  <Td>
                    <Verdict result={run} compact />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

const describe = (profile: ChaosProfile): string =>
  profile.kind === 'order' ? `order · ${profile.mode}` : `debit · ${profile.strategy}`;

function Results({ result }: { result: BurstResult }): React.JSX.Element {
  const i = result.invariants;

  return (
    <>
      <Card>
        <CardHeader
          title={`Result — ${describe(result.profile)}`}
          hint={`${String(result.virtualUsers)} users over ${String(result.accountSpread)} account(s), each funded with ${formatCash(fromMinor(BigInt(result.openingPerAccount), CASH_SCALE))}`}
          actions={<Verdict result={result} />}
        />
        <CardBody>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Succeeded" value={result.succeeded} />
            <Stat
              label="Refused"
              value={result.refused}
              note="insufficient funds — the correct outcome"
            />
            <Stat label="Errored" value={result.errored} note="a 5xx a customer would have seen" />
            <Stat
              label="Ledger attempts"
              value={result.totalAttempts}
              note={
                result.totalAttempts > result.attempted
                  ? `${String(result.totalAttempts - result.attempted)} retries`
                  : 'no retries'
              }
            />
            <Stat label="40001 serialization" value={result.serializationFailures} />
            <Stat
              label="40P01 deadlocks"
              value={result.deadlocks}
              note={
                result.deadlocks > 0 ? 'lock ordering has a hole' : 'impossible by construction'
              }
            />
            <Stat label="Duration" value={`${String(Math.round(result.durationMs))} ms`} />
            <Stat
              label="Throughput"
              value={`${String(result.throughput)}/s`}
              note="successes only, never attempts"
            />
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Invariants, checked after the burst committed" />
        <CardBody className="space-y-3">
          <Invariant
            ok={i.entriesSumToZeroPerUnit}
            label="SUM(entries.amount) = 0, per unit"
            detail={i.unitSums.map((u) => `${u.unit}: ${u.sum}`).join('  ·  ')}
            note="Checked across the whole ledger, not just this tenant — a bug that unbalanced it would not politely confine itself."
          />

          <Invariant
            ok={i.balanceMatchesEntries}
            label="accounts.balance = SUM(its entries)"
            detail={
              i.balanceMatchesEntries === null
                ? 'not applicable — this path writes no ledger entries at all'
                : i.drift.length === 0
                  ? 'no drift'
                  : i.drift
                      .map((d) => `${d.externalId}: ${d.balance} vs ${d.entriesSum}`)
                      .join('  ·  ')
            }
            note="Null for the naive debit paths. Comparing a balance against a zero entries sum would read as a drift finding when it is really 'this path keeps no ledger'."
          />

          <Invariant
            ok={!i.overdraftOccurred}
            label="No account went negative"
            detail={
              i.overdrawnAccounts.length === 0
                ? 'none'
                : i.overdrawnAccounts
                    .map(
                      (a) =>
                        `${a.externalId}: ${formatCash(fromMinor(BigInt(a.balance), CASH_SCALE))}`,
                    )
                    .join('  ·  ')
            }
          />

          {i.expectedCash !== null && i.actualCash !== null && (
            <Invariant
              ok={i.cashDiscrepancy === '0'}
              label="Final balance matches the arithmetic"
              detail={`expected ${formatCash(fromMinor(BigInt(i.expectedCash), CASH_SCALE))} · actual ${formatCash(fromMinor(BigInt(i.actualCash), CASH_SCALE))} · difference ${formatCash(fromMinor(BigInt(i.cashDiscrepancy ?? '0'), CASH_SCALE))}`}
              note="Opening balance minus the amount every successful request claimed to move. A gap is a lost update, stated in money."
            />
          )}
        </CardBody>
      </Card>
    </>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number;
  note?: string;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-ink-400 text-xs">{label}</dt>
      <dd className="num text-ink-50 mt-0.5 text-xl font-semibold">{value}</dd>
      {note !== undefined && <p className="text-ink-600 mt-0.5 text-[11px]">{note}</p>}
    </div>
  );
}

function Invariant({
  ok,
  label,
  detail,
  note,
}: {
  ok: boolean | null;
  label: string;
  detail: string;
  note?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0">
        {ok === null ? (
          <span className="text-ink-600 text-xs">n/a</span>
        ) : ok ? (
          <Check className="text-credit size-4" aria-hidden />
        ) : (
          <X className="text-debit size-4" aria-hidden />
        )}
      </span>
      <div className="min-w-0">
        <p className="text-ink-200 text-sm">{label}</p>
        <p className="num text-ink-400 mt-0.5 text-xs break-words">{detail}</p>
        {note !== undefined && <p className="text-ink-600 mt-0.5 text-[11px]">{note}</p>}
      </div>
    </div>
  );
}

function Verdict({
  result,
  compact = false,
}: {
  result: BurstResult;
  compact?: boolean;
}): React.JSX.Element {
  const i = result.invariants;

  /*
   * The verdict is deliberately strict: a run only "holds" if nothing went
   * negative, the ledger balances, and the arithmetic closes. An overdraft
   * without a lost update still counts as broken, because it is.
   */
  const broken =
    i.overdraftOccurred ||
    !i.entriesSumToZeroPerUnit ||
    i.balanceMatchesEntries === false ||
    (i.cashDiscrepancy !== null && i.cashDiscrepancy !== '0');

  return (
    <Badge tone={broken ? 'debit' : 'credit'}>
      {broken ? 'invariants broken' : 'invariants held'}
      {!compact &&
        !broken &&
        result.refused > 0 &&
        ` · ${String(result.refused)} refused correctly`}
    </Badge>
  );
}
