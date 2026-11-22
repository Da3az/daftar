import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { Withdrawal } from '@/api/types';
import { Button, Callout, Num } from '@/components/bits';
import { Panel } from '@/components/Panel';
import { showCash } from '@/lib/money';
import { showDateTime } from '@/lib/time';

/* The operator's review screen. Not linked from the navigation and useless
   without ADMIN_TOKEN: the token is kept in sessionStorage (this tab only) and
   sent as a bearer token. The API answers 404 to everything here when the
   deployment has no admin token configured. */

const TOKEN_KEY = 'daftar.adminToken';

type ReviewItem = Withdrawal & { guest: string };

interface Finding {
  id: string;
  kind: string;
  symbol: string | null;
  expected: string | null;
  actual: string | null;
  detectedAt: string;
  introducedAt: string | null;
  timeToDetectMs: number | null;
}

class AdminHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`admin API answered ${status}`);
    this.status = status;
  }
}

async function adminFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/v1/admin${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new AdminHttpError(response.status);
  return (await response.json()) as T;
}

function TokenForm({ onToken }: { onToken: (t: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) onToken(value.trim());
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4 px-7 pb-7">
      <label className="flex flex-col gap-2 text-sm">
        Admin token
        <input
          type="password"
          autoComplete="off"
          className="rounded-tag border border-line-strong bg-field px-3 py-2"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <Button type="submit" variant="brand">
        Continue
      </Button>
    </form>
  );
}

function Review({ token, onBadToken }: { token: string; onBadToken: () => void }) {
  const client = useQueryClient();
  const list = useQuery({
    queryKey: ['admin', 'withdrawals'],
    queryFn: () => adminFetch<{ withdrawals: ReviewItem[] }>(token, '/withdrawals'),
    refetchInterval: 5_000,
    retry: false,
  });
  const findings = useQuery({
    queryKey: ['admin', 'reconciliation'],
    queryFn: () =>
      adminFetch<{ findings: Finding[]; deadLetters: number }>(token, '/reconciliation?limit=20'),
    refetchInterval: 10_000,
    retry: false,
  });
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' }) =>
      adminFetch(token, `/withdrawals/${id}/${action}`, { method: 'POST' }),
    onSettled: () => client.invalidateQueries({ queryKey: ['admin'] }),
  });

  const error = list.error ?? findings.error;
  if (error instanceof AdminHttpError && (error.status === 401 || error.status === 404)) {
    return (
      <Callout tone="danger" title="Not allowed">
        {error.status === 404
          ? 'This deployment has no admin surface (ADMIN_TOKEN is not set).'
          : 'That token was refused.'}{' '}
        <button type="button" className="underline" onClick={onBadToken}>
          Enter another
        </button>
      </Callout>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Panel title="Withdrawals not yet finished" className="flex-none">
        <table className="mx-7 mb-6 text-sm">
          <thead>
            <tr className="text-left text-ink-3">
              <th className="py-1 pr-6 font-medium">Guest</th>
              <th className="py-1 pr-6 text-right font-medium">Amount</th>
              <th className="py-1 pr-6 font-medium">State</th>
              <th className="py-1 pr-6 font-medium">Since</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {(list.data?.withdrawals ?? []).map((w) => (
              <tr key={w.id} className="border-t border-line">
                <td className="py-2 pr-6">{w.guest}</td>
                <td className="num py-2 pr-6 text-right">{showCash(w.amount)}</td>
                <td className="py-2 pr-6">
                  {w.state}
                  {w.lastRailStatus ? ` · rail: ${w.lastRailStatus}` : ''}
                </td>
                <td className="num py-2 pr-6">{showDateTime(w.updatedAt)}</td>
                <td className="py-2">
                  {w.state === 'review' && (
                    <span className="flex gap-3">
                      <Button
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ id: w.id, action: 'approve' })}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="danger"
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ id: w.id, action: 'reject' })}
                      >
                        Reject and return
                      </Button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data?.withdrawals.length === 0 && (
          <p className="px-7 pb-6 text-sm text-ink-3">Nothing in flight.</p>
        )}
      </Panel>

      <Panel
        title="Reconciliation"
        aside={
          <span className="text-sm text-ink-3">
            dead letters: <Num>{findings.data?.deadLetters ?? '—'}</Num>
          </span>
        }
        className="flex-none"
      >
        <table className="mx-7 mb-6 text-sm">
          <thead>
            <tr className="text-left text-ink-3">
              <th className="py-1 pr-6 font-medium">Detected</th>
              <th className="py-1 pr-6 font-medium">Kind</th>
              <th className="py-1 pr-6 text-right font-medium">Expected</th>
              <th className="py-1 pr-6 text-right font-medium">Actual</th>
              <th className="py-1 text-right font-medium">Time to detect</th>
            </tr>
          </thead>
          <tbody>
            {(findings.data?.findings ?? []).map((f) => (
              <tr key={f.id} className="border-t border-line">
                <td className="num py-2 pr-6">{showDateTime(f.detectedAt)}</td>
                <td className="py-2 pr-6">{f.kind}</td>
                <td className="num py-2 pr-6 text-right">{f.expected ?? '—'}</td>
                <td className="num py-2 pr-6 text-right">{f.actual ?? '—'}</td>
                <td className="num py-2 text-right">
                  {f.timeToDetectMs === null ? '—' : `${(f.timeToDetectMs / 1000).toFixed(1)} s`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

export function AdminPage() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const save = (t: string | null) => {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
    setToken(t);
  };
  return (
    <div className="mx-auto flex max-w-720 flex-col gap-6 px-4 py-5 md:px-10 md:py-7">
      <h1 className="font-display text-2xl font-semibold">Operator</h1>
      {token ? (
        <Review token={token} onBadToken={() => save(null)} />
      ) : (
        <Panel title="Sign in" className="flex-none">
          <TokenForm onToken={save} />
        </Panel>
      )}
    </div>
  );
}
