import type { DepositResult, PlaceOrderRequest, Side } from '@/api/types';
import { affordableQty, formatCash, formatQty, parseCash } from '@/lib/money';
import type { Scenario } from './devSwitches';
import {
  COIN,
  LOT,
  MockMatchingEngine,
  TICK,
  createRng,
  type Clock,
  type EngineResult,
  type ParticipantId,
} from './engine';

export const SEED = 0x0daf7a2;

export interface SeededRecipient {
  handle: string;
  displayName: string;
}

export const SEEDED_RECIPIENTS: readonly SeededRecipient[] = Object.freeze([
  { handle: '7a1d09c4e2', displayName: 'Guest 2210' },
  { handle: 'c08e5b7f31', displayName: 'Guest 5532' },
  { handle: '1b94d2a6f0', displayName: 'Guest 7781' },
  { handle: 'e6f3a8019d', displayName: 'Guest 3349' },
  {
    handle: '58b2c7e4a9',
    displayName: 'Guest 9024 — Bartholomew Featherstonehaugh-Cholmondeley III',
  },
]);

export const DEMO_GUEST = Object.freeze({ displayName: 'Guest 4817', handle: '3f6c2c1e9b' });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Sparse older history so the 1h series has several hundred candles; one bot trade or so per 5-minute step. */
const SPARSE_HISTORY_MS = 21 * 24 * HOUR;
const DENSE_HISTORY_MS = 26 * HOUR;
const REFRESH_MS = 20 * MINUTE;
const DEMO_SPAN_MS = 80 * MINUTE;

/** Time the engine sees while history is generated; switched to the wall clock once seeding is done. */
export class SeedClock implements Clock {
  t: number;
  live = false;

  constructor(start: number) {
    this.t = start;
  }

  now(): number {
    return this.live ? Math.max(Date.now(), this.t) : this.t;
  }
}

function advance(
  engine: MockMatchingEngine,
  clock: SeedClock,
  until: number,
  stepMs: number,
): void {
  while (clock.t < until) {
    clock.t = Math.min(clock.t + stepMs, until);
    engine.tick(clock.t);
  }
}

let lastDemoDeposit: DepositResult | null = null;

/** The 10-delivery deposit made by the demo guest in the most recent build that included it. */
export function seededDepositResult(): DepositResult | null {
  return lastDemoDeposit;
}

export interface BuiltScenario {
  engine: MockMatchingEngine;
  demoGuestId: ParticipantId | null;
}

export function buildScenario(
  scenario: Scenario,
  opts: { demoGuest?: boolean } = {},
): BuiltScenario {
  const end = Date.now();
  const clock = new SeedClock(end - SPARSE_HISTORY_MS);
  const engine = new MockMatchingEngine({ clock, rng: createRng(SEED) });
  engine.tick(clock.t);
  for (const r of SEEDED_RECIPIENTS)
    engine.createGuest({ displayName: r.displayName, handle: r.handle });
  engine.configureBots({ active: true, trading: true, churn: 0.25 });
  engine.replenishBotQuotes();

  advance(engine, clock, end - DENSE_HISTORY_MS, 5 * MINUTE);
  let demoGuestId: ParticipantId | null = null;
  lastDemoDeposit = null;
  if (opts.demoGuest) {
    advance(engine, clock, end - DEMO_SPAN_MS, 3_000);
    engine.configureBots({ churn: 1 });
    const demo = seedDemoGuest(engine, clock);
    demoGuestId = demo.participantId;
    lastDemoDeposit = demo.depositResult;
  } else {
    advance(engine, clock, end - REFRESH_MS, 3_000);
    engine.configureBots({ churn: 1 });
    advance(engine, clock, end, 1_000);
  }

  if (scenario === 'thin') engine.cancelBotOrders('sell');
  if (scenario === 'empty') engine.cancelBotOrders('both');
  engine.configureBots({ active: scenario === 'live', trading: true });
  clock.live = true;
  return { engine, demoGuestId };
}

export interface DemoGuestSeed {
  participantId: ParticipantId;
  depositResult: DepositResult;
}

const coins = (n: bigint): string => formatQty(n * COIN);

function must<T>(result: EngineResult<T>, step: string): T {
  if (!result.ok) throw new Error(`Demo guest seed: ${step} failed with ${result.body.error}`);
  return result.value;
}

/**
 * Plays Guest 4817's last ~80 minutes through the engine, starting at the clock's current time.
 * Every order, fill, cancel and movement is real; the final step lands 100 ms before the end so its
 * three events are still in the outbox.
 */
export function seedDemoGuest(engine: MockMatchingEngine, clock: SeedClock): DemoGuestSeed {
  const start = clock.t;
  const at = (minutes: number) => advance(engine, clock, start + minutes * MINUTE, 500);
  const id = engine.createGuest({ displayName: DEMO_GUEST.displayName, handle: DEMO_GUEST.handle });

  const prices = () => {
    const { bid, ask } = engine.bestPrices();
    if (bid === null || ask === null) throw new Error('Demo guest seed: the book is one-sided');
    return {
      bid,
      ask,
      insideBid: ask - bid >= 2n * TICK ? bid + TICK : bid,
      insideAsk: ask - bid >= 2n * TICK ? ask - TICK : ask,
    };
  };
  const limit = (
    clientOrderId: string,
    side: Side,
    quantity: string,
    price: bigint,
  ): PlaceOrderRequest => ({
    type: 'limit',
    clientOrderId,
    side,
    quantity,
    limitPrice: formatCash(price),
  });
  const market = (clientOrderId: string, side: Side, quantity: string): PlaceOrderRequest => ({
    type: 'market',
    clientOrderId,
    side,
    quantity,
  });
  const place = (request: PlaceOrderRequest) =>
    must(engine.placeOrder(id, request), request.clientOrderId);

  at(3);
  const depositResult = must(engine.deposit(id, 250_000n, 10), 'deposit');

  at(8);
  place(market('demo-buy-market-01', 'buy', coins(40n)));

  at(12);
  const askBeforeThinning = prices().ask;
  engine.cancelBotOrders('buy');
  must(engine.placeBotLimit('Basil', 'buy', 3n * COIN, askBeforeThinning - 2n * TICK), 'thin bid');
  place(market('demo-sell-market-01', 'sell', coins(8n)));
  engine.replenishBotQuotes();

  at(18);
  place(limit('demo-sell-limit-01', 'sell', coins(15n), prices().bid - 2n * TICK));

  at(25);
  place(limit('demo-buy-limit-01', 'buy', coins(20n), prices().insideBid));
  must(engine.hitOrder('Kestrel', id, 'demo-buy-limit-01', 20n * COIN), 'maker buy');

  at(31);
  place(limit('demo-sell-limit-02', 'sell', coins(25n), prices().insideAsk));
  must(engine.hitOrder('Juniper', id, 'demo-sell-limit-02', 25n * COIN), 'maker sell');

  at(38);
  const firstRecipient = SEEDED_RECIPIENTS[0];
  if (firstRecipient)
    must(engine.transfer(id, 'demo-transfer-01', 15_000n, firstRecipient.handle), 'transfer out');

  at(41);
  const earlyDonor = SEEDED_RECIPIENTS[2]
    ? engine.participantIdByHandle(SEEDED_RECIPIENTS[2].handle)
    : null;
  if (earlyDonor !== null)
    must(
      engine.transfer(earlyDonor, 'gift-demo-0000', 2_500n, DEMO_GUEST.handle),
      'early transfer in',
    );

  at(45);
  place(limit('demo-buy-limit-02', 'buy', coins(30n), prices().insideBid));
  must(engine.hitOrder('Atlas', id, 'demo-buy-limit-02', 12n * COIN), 'partial fill');
  must(engine.cancelOrder(id, 'demo-buy-limit-02'), 'cancel partial');

  at(52);
  must(engine.withdraw(id, 'demo-withdraw-01', 30_000n), 'withdraw');

  at(58);
  place(limit('demo-buy-limit-03', 'buy', coins(10n), prices().bid - 9n * TICK));
  at(61);
  engine.cancelOrder(id, 'demo-buy-limit-03');

  at(74);
  engine.configureBots({ trading: false });
  at(75);
  const deepBid = prices().bid - 7n * TICK;
  const free = parseCash(engine.getMe(id).balances.cashAvailable) ?? 0n;
  place(
    limit(
      'demo-buy-limit-04',
      'buy',
      formatQty(affordableQty(free - 170_000n, deepBid, LOT)),
      deepBid,
    ),
  );

  at(76);
  place(market('demo-buy-market-02', 'buy', coins(100n)));

  at(77);
  place(limit('demo-sell-limit-03', 'sell', coins(30n), prices().insideAsk));
  place(limit('demo-sell-limit-04', 'sell', coins(15n), prices().ask + 6n * TICK));

  advance(engine, clock, start + DEMO_SPAN_MS - 100, 500);
  must(engine.hitOrder('Lumen', id, 'demo-sell-limit-03', 10n * COIN), 'final partial fill');
  const donor = SEEDED_RECIPIENTS[1]
    ? engine.participantIdByHandle(SEEDED_RECIPIENTS[1].handle)
    : null;
  if (donor !== null)
    must(engine.transfer(donor, 'gift-demo-0001', 7_500n, DEMO_GUEST.handle), 'transfer in');
  must(engine.deposit(id, 50_000n, 1), 'final deposit');
  advance(engine, clock, start + DEMO_SPAN_MS, 100);

  return { participantId: id, depositResult };
}
