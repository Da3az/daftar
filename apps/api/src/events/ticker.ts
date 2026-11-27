import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type pg from 'pg';
import { buildMarketSnapshot } from '../exchange/snapshot.ts';
import type { StringProducer } from './kafka.ts';

/**
 * # The market ticker
 *
 * One poller for everyone. Every `intervalMs` it builds the same snapshot
 * `GET /v1/exchange/market` returns and, **only if it changed**, publishes it
 * to the market topic; every API instance fans it out to its open streams.
 *
 * This is deliberately not on the matching path. The matcher commits and
 * knows nothing of this; the ticker reads committed state like any other
 * reader. The cost is up to one interval of extra latency on the book — the
 * price of never letting the broker near the transaction that moves money.
 *
 * With N viewers polling once a second the database answers N snapshot
 * queries a second; with the ticker it answers 1 / interval, independent of N.
 */

export const TICKER_DEPTH = 15;
export const TICKER_TAPE = 40;

export interface Ticker {
  stop: () => Promise<void>;
}

export function startMarketTicker(
  pool: pg.Pool,
  producer: StringProducer,
  options: { topic: string; symbol: string; intervalMs: number; log: Logger },
): Ticker {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let lastHash = '';
  let seq = 0;

  const tick = async (): Promise<void> => {
    const snapshot = await buildMarketSnapshot(pool, options.symbol, TICKER_DEPTH, TICKER_TAPE);
    if (!snapshot) return;
    const body = JSON.stringify(snapshot);
    const hash = createHash('sha1').update(body).digest('hex');
    if (hash === lastHash) return;
    seq += 1;
    await producer.send({
      messages: [
        {
          topic: options.topic,
          key: options.symbol,
          value: JSON.stringify({ seq, builtAt: new Date().toISOString(), snapshot }),
        },
      ],
    });
    lastHash = hash;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      inFlight = tick()
        .catch((err: unknown) => options.log.warn({ err }, 'market tick failed'))
        .then(schedule);
    }, options.intervalMs);
  };
  schedule();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
