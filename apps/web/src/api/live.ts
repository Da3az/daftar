import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { usingMock } from './mode';
import { keys } from './queries';
import type { MarketSnapshot } from './types';

/* Live push over server-sent events, with polling as the fallback.

   While the stream is open, polling is off for everything the stream covers.
   The moment it is not — the server has live push off (503), the connection
   dropped, the tab is in the mock — every query goes back to its polling
   interval, and when EventSource reconnects it sends Last-Event-ID so the
   server resumes from the durable feed without a gap.

   Latency is measured here, on the receiving end: each activity event carries
   when the money moved, and the difference to its arrival is kept in a small
   ring buffer for `window.__daftarLive` — what the evidence script reads. */

export type LiveState = 'off' | 'connecting' | 'live' | 'reconnecting';

let state: LiveState = 'off';
const listeners = new Set<() => void>();
const latencies: number[] = [];
let received = 0;

function setState(next: LiveState): void {
  if (state === next) return;
  state = next;
  for (const l of listeners) l();
}

export const liveState = (): LiveState => state;
export const isLive = (): boolean => state === 'live';

export function useLiveState(): LiveState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

declare global {
  interface Window {
    __daftarLive?: { state: () => LiveState; latenciesMs: () => number[]; received: () => number };
  }
}
if (typeof window !== 'undefined') {
  window.__daftarLive = {
    state: () => state,
    latenciesMs: () => [...latencies],
    received: () => received,
  };
}

const TOAST_TYPES: Record<string, string> = {
  'trade.buy': 'Your buy order filled',
  'trade.sell': 'Your sell order filled',
  'deposit.credited': 'Deposit credited',
  'transfer.received': 'Cash received',
  'withdrawal.confirmed': 'Withdrawal paid out',
  'withdrawal.released': 'Withdrawal returned to your cash',
  'withdrawal.review': 'Withdrawal waiting for a review',
};

/** Open the stream for a signed-in guest. Mounted once, in the Shell. */
export function useLiveStream(enabled: boolean): void {
  const client = useQueryClient();

  useEffect(() => {
    if (!enabled || usingMock || typeof EventSource === 'undefined') {
      setState('off');
      return;
    }

    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let failures = 0;

    // Everything the stream replaces polling for: refetch now, so the switch
    // back to polling has fresh data rather than waiting for the next tick.
    const repoll = () => {
      for (const key of [keys.me, keys.activity, keys.market, keys.position, keys.withdrawals]) {
        void client.invalidateQueries({ queryKey: key });
      }
    };

    const open = () => {
      setState(failures === 0 ? 'connecting' : 'reconnecting');
      source = new EventSource('/v1/exchange/stream', { withCredentials: true });

      source.addEventListener('open', () => {
        failures = 0;
        setState('live');
        repoll();
      });

      source.addEventListener('market', (e) => {
        try {
          const { snapshot } = JSON.parse((e as MessageEvent<string>).data) as {
            snapshot: MarketSnapshot;
          };
          client.setQueryData(keys.market, snapshot);
        } catch {
          /* a malformed frame is ignored; the next one replaces it */
        }
      });

      source.addEventListener('activity', (e) => {
        received += 1;
        let parsed: { type?: string; occurredAt?: string; replayed?: boolean } = {};
        try {
          parsed = JSON.parse((e as MessageEvent<string>).data) as typeof parsed;
        } catch {
          /* still a signal that something changed */
        }
        const at = parsed.occurredAt ? Date.parse(parsed.occurredAt) : Number.NaN;
        if (!parsed.replayed && Number.isFinite(at)) {
          latencies.push(Date.now() - at);
          if (latencies.length > 500) latencies.shift();
        }
        for (const key of [
          keys.me,
          keys.activity,
          keys.orders,
          keys.fills,
          keys.position,
          keys.withdrawals,
        ]) {
          void client.invalidateQueries({ queryKey: key });
        }
        const title = parsed.type ? TOAST_TYPES[parsed.type] : undefined;
        if (title && !parsed.replayed) toast(title);
      });

      source.addEventListener('notification', () => {
        void client.invalidateQueries({ queryKey: keys.notifications });
      });

      source.addEventListener('resync', () => repoll());

      source.addEventListener('error', () => {
        // EventSource retries by itself after a network error (and sends
        // Last-Event-ID). It gives up on an HTTP error such as 503 — then the
        // readyState is CLOSED and we schedule our own retry, slowly.
        failures += 1;
        setState('reconnecting');
        repoll();
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          source = null;
          if (!disposed) {
            retry = setTimeout(open, Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5)));
          }
        }
      });
    };

    open();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      source?.close();
      setState('off');
    };
  }, [enabled, client]);
}
