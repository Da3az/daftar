import { useEffect, useRef, useState } from 'react';

/**
 * # Live market data — display only
 *
 * ## The rule that protects the project
 *
 * **Nothing here ever reaches a ledger entry.** Orders are priced from the
 * `instruments` table's frozen reference price, the order endpoint makes zero
 * network calls, and the benchmarks run against a fixed price table with no
 * feed at all.
 *
 * That is not caution for its own sake. If an order's amount came from a live
 * feed then every evidence file in `docs/evidence/` would be unreproducible —
 * the notional would differ on every run, so the same benchmark would produce
 * different balances and no before/after pair could be compared. It would also
 * mean the ledger write path had a network dependency, and a p99 that includes
 * somebody else's API is not a p99 of this system.
 *
 * The gap is visible rather than hidden: at the time of writing the live BTC
 * price is around $59,300 and the frozen reference price is $95,432.17. The
 * Trade page labels both and prices the order from the second.
 *
 * ## Why a WebSocket with a REST fallback
 *
 * Binance's public market-data endpoints need no API key, which is the only
 * reason a feed is viable here at all. But they **geo-block some regions**, and
 * a chart that silently stays empty for a visitor in one of them looks like a
 * broken page rather than a blocked request. So: try the stream, fall back to
 * polling, and when both fail say so in the UI instead of showing nothing.
 */

const WS_ENDPOINT = 'wss://stream.binance.com:9443/stream';
const REST_ENDPOINT = 'https://api.binance.com/api/v3';

/** The fixed asset list, matching the seeded `instruments` table. */
export const SYMBOLS = ['BTC', 'ETH', 'ARB'] as const;
export type Symbol = (typeof SYMBOLS)[number];

/** Binance pairs everything against USDT; the ledger's cash unit is USD. */
const pairFor = (symbol: string): string => `${symbol.toLowerCase()}usdt`;

export interface Ticker {
  symbol: string;
  /** Exact decimal string, as Binance sends it. Never parsed to a number. */
  lastPrice: string;
  priceChangePercent: string;
  at: number;
}

export type FeedStatus = 'connecting' | 'live' | 'polling' | 'unavailable';

interface StreamMessage {
  stream?: string;
  data?: { s?: string; c?: string; P?: string; E?: number };
}

/**
 * Subscribe to the combined ticker stream, falling back to REST polling.
 *
 * Returns a map keyed by the ledger's symbol (`BTC`), not Binance's pair
 * (`btcusdt`), so callers never deal with the exchange's naming.
 */
export function useTickers(): { tickers: Record<string, Ticker>; status: FeedStatus } {
  const [tickers, setTickers] = useState<Record<string, Ticker>>({});
  const [status, setStatus] = useState<FeedStatus>('connecting');

  /*
   * The socket and the poll timer live in refs, not state. Putting them in
   * state would re-run this effect on every message, tearing the connection
   * down and rebuilding it — which looks like a flapping feed and is actually
   * the component fighting itself.
   */
  const socketRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;

    const poll = async (): Promise<void> => {
      try {
        const results = await Promise.all(
          SYMBOLS.map(async (symbol) => {
            const response = await fetch(
              `${REST_ENDPOINT}/ticker/24hr?symbol=${pairFor(symbol).toUpperCase()}`,
            );
            if (!response.ok) throw new Error(`binance ${String(response.status)}`);

            const body = (await response.json()) as {
              lastPrice: string;
              priceChangePercent: string;
              closeTime: number;
            };

            return [
              symbol,
              {
                symbol,
                lastPrice: body.lastPrice,
                priceChangePercent: body.priceChangePercent,
                at: body.closeTime,
              },
            ] as const;
          }),
        );

        if (disposed) return;
        setTickers(Object.fromEntries(results));
        setStatus('polling');
      } catch {
        if (!disposed) setStatus('unavailable');
      }
    };

    const startPolling = (): void => {
      if (pollRef.current !== null || disposed) return;
      void poll();
      // 10s. Frequent enough to look live, infrequent enough to stay well
      // inside Binance's unauthenticated weight budget for three symbols.
      pollRef.current = window.setInterval(() => void poll(), 10_000);
    };

    try {
      const streams = SYMBOLS.map((s) => `${pairFor(s)}@ticker`).join('/');
      const socket = new WebSocket(`${WS_ENDPOINT}?streams=${streams}`);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        if (!disposed) setStatus('live');
      });

      socket.addEventListener('message', (event: MessageEvent<string>) => {
        if (disposed) return;

        let parsed: StreamMessage;
        try {
          parsed = JSON.parse(event.data) as StreamMessage;
        } catch {
          return;
        }

        const data = parsed.data;
        if (!data?.s || !data.c) return;

        // `s` is the pair (`BTCUSDT`); strip the quote asset to get the
        // ledger's symbol. Done by suffix removal rather than slicing a fixed
        // width, because symbol lengths differ (`ARB` vs `BTC` vs longer).
        const symbol = data.s.replace(/USDT$/, '');

        setTickers((current) => ({
          ...current,
          [symbol]: {
            symbol,
            lastPrice: data.c!,
            priceChangePercent: data.P ?? '0',
            at: data.E ?? Date.now(),
          },
        }));
      });

      /*
       * Both `error` and `close` fall back to polling.
       *
       * A geo-block presents as an immediate close rather than an error event
       * in some browsers, so handling only `error` leaves the chart empty for
       * exactly the visitors the fallback exists for.
       */
      socket.addEventListener('error', startPolling);
      socket.addEventListener('close', startPolling);
    } catch {
      startPolling();
    }

    return () => {
      disposed = true;
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = null;

      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState <= WebSocket.OPEN) {
        // Remove the close listener before closing, or the teardown triggers
        // the fallback and starts a poll timer that nothing will ever clear.
        socket.removeEventListener('close', startPolling);
        socket.close();
      }
    };
  }, []);

  return { tickers, status };
}

export interface Candle {
  /** Seconds, which is what lightweight-charts expects. Binance sends ms. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Historical candles for the chart.
 *
 * **These become `number`, and that is correct** — unlike every amount in this
 * app. A chart pixel is a float by nature, the values are never summed, and
 * nothing derived from them is ever written. `lightweight-charts` takes numbers
 * and there is no precision claim being made.
 */
export async function fetchCandles(
  symbol: string,
  interval = '1m',
  limit = 180,
): Promise<Candle[]> {
  const response = await fetch(
    `${REST_ENDPOINT}/klines?symbol=${pairFor(symbol).toUpperCase()}&interval=${interval}&limit=${String(limit)}`,
  );
  if (!response.ok) throw new Error(`binance klines ${String(response.status)}`);

  // Positional array: [openTime, open, high, low, close, volume, closeTime, ...].
  // Verified against the live endpoint rather than assumed.
  const rows = (await response.json()) as [number, string, string, string, string, ...unknown[]][];

  return rows.map(([openTime, open, high, low, close]) => ({
    time: Math.floor(openTime / 1000),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
  }));
}
