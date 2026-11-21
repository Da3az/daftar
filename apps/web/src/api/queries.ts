import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useApi } from './context';
import type { CandleInterval } from './types';

/* Polling cadences. Live but polled: a failed refresh keeps the last good data on screen
   (TanStack Query keeps `data` when a refetch errors) and the next tick simply tries again. */
export const POLL = { market: 1000, session: 2000, activity: 2000, history: 5000 } as const;

export const keys = {
  market: ['market'] as const,
  candles: (interval: CandleInterval) => ['candles', interval] as const,
  me: ['me'] as const,
  orders: ['orders'] as const,
  fills: ['fills'] as const,
  activity: ['activity'] as const,
};

const common = { retry: false, refetchOnWindowFocus: true, staleTime: 0 } as const;

export function useMarket() {
  const api = useApi();
  return useQuery({
    queryKey: keys.market,
    queryFn: () => api.getMarket({ depth: 15, tape: 40 }),
    refetchInterval: POLL.market,
    ...common,
  });
}

export function useCandles(interval: CandleInterval) {
  const api = useApi();
  return useQuery({
    queryKey: keys.candles(interval),
    queryFn: () => api.getCandles(interval, 240),
    refetchInterval: POLL.market,
    ...common,
  });
}

/** The session. `data === null` means "no account on this browser" — and such a visitor is not polled. */
export function useMe() {
  const api = useApi();
  return useQuery({
    queryKey: keys.me,
    queryFn: () => api.getMe(),
    refetchInterval: (query) => (query.state.data ? POLL.session : false),
    ...common,
  });
}

function useHasSession(): boolean {
  return Boolean(useMe().data);
}

export function useOrders() {
  const api = useApi();
  const enabled = useHasSession();
  return useQuery({
    queryKey: keys.orders,
    queryFn: () => api.listOrders({ status: 'all', limit: 100 }),
    refetchInterval: POLL.history,
    enabled,
    ...common,
  });
}

export function useFills() {
  const api = useApi();
  const enabled = useHasSession();
  return useQuery({
    queryKey: keys.fills,
    queryFn: () => api.listFills(200),
    refetchInterval: POLL.history,
    enabled,
    ...common,
  });
}

export function useActivity() {
  const api = useApi();
  const enabled = useHasSession();
  return useQuery({
    queryKey: keys.activity,
    queryFn: () => api.getActivity(100),
    refetchInterval: POLL.activity,
    enabled,
    ...common,
  });
}

/** After something the guest did: refresh everything that could have changed, now rather than on the next tick. */
export function useRefreshSession(): () => void {
  const client = useQueryClient();
  return () => {
    for (const key of [keys.me, keys.orders, keys.fills, keys.activity, keys.market])
      void client.invalidateQueries({ queryKey: key });
  };
}

export interface Freshness {
  /** A refresh failed and older data is being shown. */
  stale: boolean;
  /** No data has ever arrived. */
  empty: boolean;
  /** When the data on screen was fetched (ms), or 0. */
  asOf: number;
}

export function freshness(query: UseQueryResult<unknown>): Freshness {
  return {
    stale: query.isError && query.data !== undefined,
    empty: query.data === undefined,
    asOf: query.dataUpdatedAt,
  };
}
