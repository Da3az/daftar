import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { exchangeOrdersTotal, exchangeTradesTotal } from '../observability/metrics.ts';
import { cancelBookOrder, placeBookOrder, type Market, type Side } from './engine.ts';
import { ensureBots, findParticipant } from './participants.ts';
import { getBook, getMarket, listOrders } from './queries.ts';

/**
 * # The market-making bots
 *
 * A dozen participants with unlimited balances that post and take orders at
 * random levels around the current price, so that a guest arriving at any hour
 * finds a book with two sides and a tape that moves.
 *
 * ## They are ordinary participants
 *
 * A bot calls `placeBookOrder()` — the function behind `POST
 * /v1/exchange/orders` — and nothing else. It has no private path into the
 * book, cannot set the price, and every trade it makes is four ledger entries
 * like anyone's. What makes it a bot is one enum value, which exempts its
 * accounts from the non-negative check. The price a guest sees is therefore
 * whatever the last two participants agreed on, bots included; there is no
 * price series being *generated* anywhere.
 *
 * ## Randomness here is not money
 *
 * This file is the one place in the server that uses floating point near a
 * price. The floats decide *what a bot feels like doing* — which side, how far
 * from the mid, how much — and the result is converted to an integer number of
 * ticks or lots before it leaves this file. No amount that reaches the engine,
 * and so none that reaches the ledger, was ever a float.
 *
 * ## One leader
 *
 * The runner holds a session-level advisory lock for as long as it trades.
 * Start two API instances with bots enabled and one of them trades while the
 * other waits; if the leader dies, PostgreSQL releases the lock with its
 * connection and the waiter takes over. Without it, scaling the API to two
 * instances would silently double the number of bots.
 */

/**
 * Advisory lock key, in the two-`int4` key space.
 *
 * That space does not overlap the single-`bigint` space the ledger uses for
 * account locks, so this cannot collide with an account id however many
 * accounts there are. The first number is "daft" in ASCII.
 */
const LEADER_LOCK = [0x64616674, 1] as const;

/** How often a non-leader asks again. */
const LEADER_RETRY_MS = 30_000;

/** A bot holding more resting orders than this withdraws its oldest first. */
const MAX_OPEN_ORDERS_PER_BOT = 6;

const QUANTITY_SCALE_UNITS = 100_000_000;

export interface BotOptions {
  symbol: string;
  count: number;
  meanIntervalMs: number;
  log: FastifyBaseLogger;
}

export interface BotRunner {
  /** Stop trading, wait for in-flight orders, release the leader lock. */
  stop: () => Promise<void>;
}

const uniform = (low: number, high: number): number => low + Math.random() * (high - low);

/** Log-uniform: small values common, large ones rare — how order sizes look. */
const logUniform = (low: number, high: number): number =>
  Math.exp(uniform(Math.log(low), Math.log(high)));

/** A quantity of `coins`, as a whole number of lots, never less than one lot. */
function quantityOf(coins: number, market: Market): bigint {
  const lots = BigInt(
    Math.max(1, Math.round((coins * QUANTITY_SCALE_UNITS) / Number(market.lotSize))),
  );
  return lots * market.lotSize;
}

/**
 * A quote `basisPoints` (1/100 of a percent) away from the mid, on a tick.
 *
 * ## The rounding is directional, and has to be
 *
 * A bid rounds **down** to its tick and an offer rounds **up** — each away from
 * the mid. The first version of this floored both, which reads as harmless and
 * is not: flooring a bid moves it away from the mid while flooring an offer
 * moves it *toward* the mid, so every pair of quotes sat about half a tick low.
 * The next mid was computed from those quotes, and the next quotes from that
 * mid. It was a ratchet: the price fell 13% in half an hour in a straight line,
 * with the mean reversion below pushing the other way the whole time and
 * losing.
 *
 * The mid itself is passed in **doubled** (`bestBid + bestAsk`) for the same
 * reason. Halving it first would floor a half-tick mid before the quote was
 * even computed, which is the same bias one step earlier.
 */
function quoteAt(doubledMid: bigint, basisPoints: number, side: Side, market: Market): bigint {
  const offset = BigInt(Math.round(basisPoints));
  const numerator = doubledMid * (side === 'buy' ? 10_000n - offset : 10_000n + offset);
  // Two for the doubled mid, 10,000 for basis points, then down to whole ticks.
  const denominator = 20_000n * market.tickSize;

  const ticks =
    side === 'buy' ? numerator / denominator : (numerator + denominator - 1n) / denominator;
  const price = ticks * market.tickSize;

  if (price < market.minPrice) return market.minPrice;
  if (price > market.maxPrice) return market.maxPrice;
  return price;
}

/**
 * How likely the next aggressive order is a buy.
 *
 * Left alone, random buying and selling is a random walk, and a random walk
 * reaches the edge of the price band eventually and stays there. So the further
 * the price sits from where the market opened, the more the bots lean back
 * toward it — gently enough that it still wanders, firmly enough that it does
 * not leave.
 */
function buyProbability(doubledMid: bigint, market: Market): number {
  const drift = Math.log(Number(doubledMid) / (2 * Number(market.openingPrice)));
  return Math.min(0.9, Math.max(0.1, 0.5 - 0.35 * Math.tanh(drift * 1.5)));
}

async function act(pool: pg.Pool, botExternalId: string, options: BotOptions): Promise<void> {
  const { symbol, log } = options;

  const [market, book, bot] = await Promise.all([
    getMarket(pool, symbol),
    getBook(pool, symbol, 1),
    findParticipant(pool, botExternalId),
  ]);
  if (!market || !bot) return;

  const open = await listOrders(pool, bot.id, { openOnly: true, limit: 20 });

  const cancel = async (orderExternalId: string): Promise<void> => {
    await cancelBookOrder(pool, {
      participantExternalId: botExternalId,
      orderExternalId,
      reason: 'bot_requote',
    });
  };

  // Stale quotes first. `listOrders` is newest-first, so the last is the oldest.
  if (open.length > MAX_OPEN_ORDERS_PER_BOT) {
    await cancel(open[open.length - 1]!.externalId);
    return;
  }

  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  // Twice the mid, so a mid that falls between two ticks is not floored away.
  const doubledMid =
    bestBid !== undefined && bestAsk !== undefined ? bestBid + bestAsk : 2n * market.lastPrice;

  const place = async (order: {
    side: Side;
    type: 'limit' | 'market';
    quantity: bigint;
    limitPrice?: bigint;
  }): Promise<void> => {
    const result = await placeBookOrder(pool, {
      externalId: `${botExternalId}:${randomUUID()}`,
      participantExternalId: botExternalId,
      symbol,
      ...order,
    });

    exchangeOrdersTotal.inc({
      actor: 'bot',
      side: order.side,
      type: order.type,
      outcome: result.status,
    });

    if (result.status === 'accepted' && result.fills.length > 0) {
      exchangeTradesTotal.inc({ taker_side: order.side }, result.fills.length);
    }

    log.debug(
      { bot: botExternalId, side: order.side, type: order.type, outcome: result.status },
      'bot order',
    );
  };

  const roll = Math.random();

  if (roll < 0.62) {
    /**
     * A resting quote: a bid below the mid or an offer above it, between 0.05%
     * and 1.5% away.
     *
     * Kept on its own side of the book explicitly. Rounding to a tick can land
     * a bid exactly on the best offer, where it would trade instead of rest and
     * make "posts liquidity" a description of intent rather than of behaviour.
     */
    const side: Side = Math.random() < 0.5 ? 'buy' : 'sell';
    const distance = logUniform(5, 150);
    let limitPrice = quoteAt(doubledMid, distance, side, market);

    if (side === 'buy' && bestAsk !== undefined && limitPrice >= bestAsk) {
      limitPrice = bestAsk - market.tickSize;
    }
    if (side === 'sell' && bestBid !== undefined && limitPrice <= bestBid) {
      limitPrice = bestBid + market.tickSize;
    }
    if (limitPrice < market.minPrice || limitPrice > market.maxPrice) return;

    await place({
      side,
      type: 'limit',
      quantity: quantityOf(logUniform(0.5, 40), market),
      limitPrice,
    });
    return;
  }

  if (roll < 0.9) {
    // A market order: this is what prints trades and moves the price.
    const side: Side = Math.random() < buyProbability(doubledMid, market) ? 'buy' : 'sell';
    await place({ side, type: 'market', quantity: quantityOf(logUniform(0.2, 12), market) });
    return;
  }

  // Otherwise pull a quote at random, so the book turns over rather than
  // accumulating orders nobody will ever reach.
  const victim = open[Math.floor(Math.random() * open.length)];
  if (victim) await cancel(victim.externalId);
}

export function startBots(pool: pg.Pool, options: BotOptions): BotRunner {
  const { log } = options;

  let stopped = false;
  let leader: pg.PoolClient | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  const timers = new Set<NodeJS.Timeout>();
  const inFlight = new Set<Promise<void>>();

  const clearTimers = (): void => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  /**
   * One bot's loop: act, then sleep a random 0.5x–1.5x of the mean and go
   * again. `setTimeout` re-armed after each action rather than `setInterval`,
   * so a slow database makes the bots slower instead of stacking overlapping
   * actions behind each other.
   */
  const schedule = (botExternalId: string, delayMs: number): void => {
    if (stopped || leader === null) return;

    const timer = setTimeout(() => {
      timers.delete(timer);

      const run = act(pool, botExternalId, options)
        .then(() => uniform(0.5, 1.5) * options.meanIntervalMs)
        .catch((err: unknown) => {
          /*
           * Caught here, always. `server.ts` exits the process on an unhandled
           * rejection, which is right for a request path and would mean one
           * failed bot order takes the API down.
           *
           * Backed off fourfold: if the database is unavailable, twelve bots
           * retrying at full rate is twelve more things failing.
           */
          log.warn({ err, bot: botExternalId }, 'bot action failed');
          return 4 * options.meanIntervalMs;
        })
        .then((nextDelayMs) => {
          inFlight.delete(run);
          schedule(botExternalId, nextDelayMs);
        });

      inFlight.add(run);
    }, delayMs);

    timers.add(timer);
  };

  const loseLeadership = (client: pg.PoolClient, err?: Error): void => {
    if (leader !== client) return;
    leader = null;
    clearTimers();
    // `true` destroys the connection rather than returning it to the pool: it
    // may be broken, and a session lock must not travel with it.
    client.release(true);
    log.warn({ err }, 'bot leader connection lost; standing by');
    if (!stopped) retryTimer = setTimeout(() => void campaign(), LEADER_RETRY_MS);
  };

  const campaign = async (): Promise<void> => {
    retryTimer = null;
    if (stopped || leader !== null) return;

    let client: pg.PoolClient | null = null;
    try {
      client = await pool.connect();

      const { rows } = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired',
        [LEADER_LOCK[0], LEADER_LOCK[1]],
      );

      if (rows[0]?.acquired !== true) {
        client.release();
        log.info('another instance is running the bots; standing by');
        retryTimer = setTimeout(() => void campaign(), LEADER_RETRY_MS);
        return;
      }

      const bots = await ensureBots(pool, options.count);

      const held = client;
      held.on('error', (err) => loseLeadership(held, err));
      leader = held;

      log.info({ bots: bots.length, mean_interval_ms: options.meanIntervalMs }, 'bots trading');

      // Staggered across one mean interval, so they do not all act on the same
      // tick forever after.
      for (const botExternalId of bots) schedule(botExternalId, uniform(0, options.meanIntervalMs));
    } catch (err) {
      client?.release(true);
      log.warn({ err }, 'could not start the bots; will retry');
      if (!stopped) retryTimer = setTimeout(() => void campaign(), LEADER_RETRY_MS);
    }
  };

  void campaign();

  return {
    stop: async () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      clearTimers();

      // Let orders already in the engine finish: each is one transaction, and
      // closing the pool under it would turn a clean shutdown into a rollback.
      await Promise.allSettled([...inFlight]);

      const held = leader;
      leader = null;
      if (held) {
        try {
          await held.query('SELECT pg_advisory_unlock($1::int, $2::int)', [...LEADER_LOCK]);
          held.release();
        } catch {
          held.release(true);
        }
      }
    },
  };
}
