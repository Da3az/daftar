import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useApi } from '@/api/context';
import { useRefreshSession } from '@/api/queries';
import { Button, Callout, Num } from '@/components/bits';
import { Panel } from '@/components/Panel';
import { showCash } from '@/lib/money';
import { describeGuestError } from './errors';

/** One click creates a funded guest account, from whichever page the visitor is on. */
export function useEnterAsGuest() {
  const api = useApi();
  const refresh = useRefreshSession();
  return useMutation({
    mutationFn: () => api.enterAsGuest(),
    onSuccess: (result) => {
      toast.success(`You are ${result.participant.displayName}`, {
        description: `${showCash(result.startingCash)} of play money is yours to trade. This browser's cookie is the only key to the account.`,
      });
      refresh();
    },
  });
}

const SHOWS: Record<'portfolio' | 'history', { title: string; lines: string[] }> = {
  portfolio: {
    title: 'Your portfolio starts with one click',
    lines: [
      'What your account is worth, and how much of it you can use',
      'Profit or loss measured against what you put in',
      'Deposit, withdraw, and send cash to another guest by handle',
    ],
  },
  history: {
    title: 'Your history starts with one click',
    lines: [
      'Every movement of your cash, with the ledger lines behind it',
      'Every fill, from either side of the book',
      'Every order you place, whatever became of it',
    ],
  },
};

/** Shown where a page needs a session and this browser has none: say what the page holds, and let them in right here. */
export function GuestEntry({ page }: { page: 'portfolio' | 'history' }) {
  const enter = useEnterAsGuest();
  const refusal = enter.isError ? describeGuestError(enter.error) : null;
  const { title, lines } = SHOWS[page];
  return (
    <div className="mx-auto max-w-280 px-4 py-5 md:px-10 md:py-10">
      <Panel title={title}>
        <div className="flex flex-col gap-6 px-7 pb-7">
          <p className="text-md text-ink-2">
            There is no account on this browser yet. Enter as a guest and you are handed{' '}
            <Num className="font-semibold text-ink">10,000.00</Num> of play money straight away — no
            sign-up, no email, no password.
          </p>
          <ul className="border-y border-line py-3 text-md">
            {lines.map((line) => (
              <li key={line} className="flex gap-4 py-1">
                <span aria-hidden className="text-ink-3">
                  —
                </span>
                {line}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
            <Button
              variant="brand"
              className="h-22 rounded-panel px-12 font-display text-lg font-semibold"
              disabled={enter.isPending}
              onClick={() => enter.mutate()}
            >
              {enter.isPending ? 'Creating your account…' : 'Enter as guest'}
            </Button>
            <p className="min-w-0 flex-1 basis-120 text-sm text-ink-2">
              Your session is a cookie on this browser. Clear it and the account is gone for good —
              there is nothing to recover it with.
            </p>
          </div>
          {refusal && (
            <Callout tone={refusal.tone} title={refusal.title} role="alert">
              {refusal.detail}
            </Callout>
          )}
        </div>
      </Panel>
    </div>
  );
}
