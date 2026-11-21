import type {
  ActivityResponse,
  ApiErrorBody,
  CancelReason,
  CandleInterval,
  CandlesResponse,
  DayStats,
  DepositDelivery,
  DepositResult,
  ExchangeOrder,
  Fill,
  LedgerEntry,
  Liquidity,
  MarketSnapshot,
  Me,
  MovementResult,
  OrderStatus,
  OrderType,
  OwnFill,
  ParticipantKind,
  PlaceOrderRequest,
  Recipient,
  Side,
} from '@/api/types';
import { affordableQty, formatCash, formatQty, notional } from '@/lib/money';

// ------------------------------------------------------------------ market constants (minor units)
export const SYMBOL = 'DFT';
export const MARKET_NAME = 'Daftar Token';
export const COIN = 100_000_000n;
export const LOT = 1_000_000n;
export const TICK = 1n;
export const MIN_PRICE = 100n;
export const MAX_PRICE = 1_000_000n;
export const OPENING_PRICE = 2_500n;
export const MAX_ORDER_QTY = 100_000n * COIN;
export const MAX_OPEN_ORDERS = 50;
export const GUEST_OPENING_CREDIT = 1_000_000n;
export const MAX_DEPOSIT = 1_000_000n;
export const MAX_MOVEMENT = 100_000_000n;
export const MAX_CATCHUP_MS = 5_000;
export const BOT_NAMES = [
  'Atlas',
  'Basil',
  'Cedar',
  'Dune',
  'Ember',
  'Fjord',
  'Garnet',
  'Harbor',
  'Indigo',
  'Juniper',
  'Kestrel',
  'Lumen',
  'Marlow',
  'Nimbus',
  'Orchid',
  'Pavo',
] as const;

const BOT_CASH = 500_000_000n;
const BOT_COIN = 200_000n * COIN;
const BOT_QUOTES = 8;
const QUOTE_LEVEL_COUNT = 14;
const QUOTE_LEVELS = BigInt(QUOTE_LEVEL_COUNT);
const FAIR_CENTER = 2_512n;
const FAIR_MIN = 2_492n;
const FAIR_MAX = 2_533n;
const QUOTE_ACTIONS_PER_MS = 2 / 1_000;
const FAIR_STEPS_PER_MS = 1 / 15_000;
const INBOUND_PER_MS = 1 / 240_000;
const TAPE_KEEP = 500;
const HISTORY_KEEP = 500;
const LEDGER_KEEP = 2_000;
const DAY_MS = 86_400_000;
const CANDLES: Record<CandleInterval, { seconds: number; keep: number }> = {
  '1m': { seconds: 60, keep: 1_500 },
  '5m': { seconds: 300, keep: 500 },
  '1h': { seconds: 3_600, keep: 500 },
};

// ------------------------------------------------------------------ seams
export interface Clock {
  now(): number;
}

/** Uniform float in [0, 1). */
export type Rng = () => number;

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const split = (): number => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = split();
  let b = split();
  let c = split();
  let d = split();
  return () => {
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4_294_967_296;
  };
}

export type ParticipantId = number;

export interface EngineFailure {
  ok: false;
  status: number;
  body: ApiErrorBody;
}
export type EngineResult<T> = { ok: true; value: T } | EngineFailure;

export interface PlacedOrder {
  order: ExchangeOrder;
  fills: Fill[];
}

export interface OrderRequirement {
  unit: string;
  available: string;
  required: string;
}

export interface GuestIdentity {
  displayName: string;
  handle: string;
  createdAt: number;
}

export interface TickOptions {
  /** false holds the activity worker (nothing is published, pending grows). */
  publish?: boolean;
}

export interface AuditReport {
  ok: boolean;
  problems: string[];
}

/** What the API layer needs from an exchange. Amounts in are minor units; everything out is wire-shaped. */
export interface MatchingEngine {
  now(): number;
  tick(nowMs: number, opts?: TickOptions): void;
  audit(): AuditReport;

  createGuest(identity?: Partial<GuestIdentity>): ParticipantId;
  guestIdentity(id: ParticipantId): GuestIdentity | null;
  bindSession(token: string, id: ParticipantId): void;
  resolveSession(token: string): ParticipantId | null;
  endSession(token: string): void;

  getMe(id: ParticipantId): Me;
  listOrders(id: ParticipantId, status: 'open' | 'all', limit: number): ExchangeOrder[];
  listFills(id: ParticipantId, limit: number): OwnFill[];
  getActivity(id: ParticipantId, limit: number): ActivityResponse;
  getMarket(depth: number, tape: number): MarketSnapshot;
  getCandles(interval: CandleInterval, limit: number): CandlesResponse;

  /** First business-rule failure placeOrder would return (409/422), without changing anything. */
  checkOrder(id: ParticipantId, request: PlaceOrderRequest): EngineFailure | null;
  orderRequirement(id: ParticipantId, request: PlaceOrderRequest): OrderRequirement;
  placeOrder(id: ParticipantId, request: PlaceOrderRequest): EngineResult<PlacedOrder>;
  cancelOrder(id: ParticipantId, clientOrderId: string): EngineResult<{ status: 'cancelled' }>;

  cashAvailable(id: ParticipantId): bigint;
  deposit(id: ParticipantId, amount: bigint, deliveries: number): EngineResult<DepositResult>;
  withdraw(id: ParticipantId, clientId: string, amount: bigint): EngineResult<MovementResult>;
  transfer(
    id: ParticipantId,
    clientId: string,
    amount: bigint,
    toHandle: string,
  ): EngineResult<MovementResult>;
  lookupRecipient(id: ParticipantId, handle: string): EngineResult<Recipient>;
}

// ------------------------------------------------------------------ internal state
interface Wallet {
  readonly label: string;
  cash: bigint;
  coin: bigint;
}

interface Contributions {
  openingCredit: bigint;
  deposits: bigint;
  transfersIn: bigint;
  withdrawals: bigint;
  transfersOut: bigint;
}

interface Party {
  readonly id: ParticipantId;
  readonly kind: ParticipantKind;
  readonly displayName: string;
  readonly handle: string | null;
  readonly createdAt: number;
  readonly wallet: Wallet;
  reservedCash: bigint;
  reservedCoin: bigint;
  readonly open: Map<string, Order>;
  readonly closed: Order[];
  readonly orderIds: Set<string>;
  readonly movementIds: Set<string>;
  readonly fills: FillRecord[];
  readonly contributions: Contributions;
  readonly pending: FeedEvent[];
  readonly feed: FeedEvent[];
  lastPublishAt: number;
  nextOrderNo: number;
}

interface Order {
  readonly seq: number;
  readonly owner: Party;
  readonly clientOrderId: string;
  readonly side: Side;
  readonly type: OrderType;
  readonly limitPrice: bigint | null;
  readonly quantity: bigint;
  filled: bigint;
  status: OrderStatus;
  cancelReason: CancelReason | null;
  readonly createdAt: number;
  updatedAt: number;
}

interface Level {
  readonly price: bigint;
  readonly orders: Order[];
}

interface TradeRecord {
  readonly id: number;
  readonly price: bigint;
  readonly quantity: bigint;
  readonly takerSide: Side;
  readonly at: number;
}

interface FillRecord {
  readonly tradeId: number;
  readonly clientOrderId: string;
  readonly side: Side;
  readonly liquidity: Liquidity;
  readonly price: bigint;
  readonly quantity: bigint;
  readonly cost: bigint;
  readonly at: number;
  readonly counterparty: string;
}

interface FeedEvent {
  readonly id: number;
  readonly type: string;
  readonly occurredAt: number;
  readonly publishAt: number;
  publishedAt: number;
  readonly amount: bigint | null;
  readonly side: Side | null;
  readonly liquidity: Liquidity | null;
  readonly price: bigint | null;
  readonly quantity: bigint | null;
  readonly counterparty: string | null;
  readonly reference: string | null;
  readonly entries: LedgerEntry[];
}

type EventFields = Partial<
  Omit<FeedEvent, 'id' | 'type' | 'occurredAt' | 'publishAt' | 'publishedAt' | 'entries'>
>;

interface Bucket {
  readonly time: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volume: bigint;
  trades: number;
}

interface ParsedOrder {
  readonly type: OrderType;
  readonly side: Side;
  readonly clientOrderId: string;
  readonly quantity: bigint;
  readonly limitPrice: bigint | null;
}

type Posting = readonly [Wallet, 'USD' | 'DFT', bigint];

interface Transaction {
  readonly id: number;
  readonly at: number;
  readonly postings: readonly Posting[];
}

type MatchStop = 'filled' | 'limit' | 'exhausted' | 'funds';

// ------------------------------------------------------------------ helpers
const iso = (ms: number): string => new Date(ms).toISOString();
const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const opposite = (side: Side): Side => (side === 'buy' ? 'sell' : 'buy');
const remaining = (o: Order): bigint => o.quantity - o.filled;

/** Decimal string → units at `decimals`; null when it is finer than one unit. Never goes through `number`. */
function parseScaled(value: string, decimals: number): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  if (fraction.length > decimals) return null;
  const units = BigInt((match[2] ?? '0') + fraction.padEnd(decimals, '0'));
  return match[1] === '-' ? -units : units;
}

function failure(
  status: number,
  error: string,
  message: string,
  extra: Partial<ApiErrorBody> = {},
): EngineFailure {
  return { ok: false, status, body: { error, message, ...extra } };
}

function insufficient(unit: string, available: string, required: string): EngineFailure {
  return failure(422, 'insufficient_funds', `Not enough ${unit} available.`, {
    unit,
    available,
    required,
  });
}

const entry = (
  account: string,
  direction: 'debit' | 'credit',
  amount: string,
  unit: string,
): LedgerEntry => ({
  account,
  direction,
  amount,
  unit,
});

function orderWire(o: Order, withTimes: boolean): ExchangeOrder {
  const wire: ExchangeOrder = {
    clientOrderId: o.clientOrderId,
    symbol: SYMBOL,
    side: o.side,
    type: o.type,
    limitPrice: o.limitPrice === null ? null : formatCash(o.limitPrice),
    quantity: formatQty(o.quantity),
    filledQuantity: formatQty(o.filled),
    status: o.status,
    cancelReason: o.cancelReason,
  };
  if (withTimes) {
    wire.createdAt = iso(o.createdAt);
    wire.updatedAt = iso(o.updatedAt);
  }
  return wire;
}

// ------------------------------------------------------------------ engine
export class MockMatchingEngine implements MatchingEngine {
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly parties = new Map<ParticipantId, Party>();
  private readonly byHandle = new Map<string, Party>();
  private readonly sessions = new Map<string, Party>();
  private readonly guestNumbers = new Set<string>();
  private readonly bots: Party[] = [];
  private readonly openingSource: Wallet = { label: 'Opening credit', cash: 0n, coin: 0n };
  private readonly providerClearing: Wallet = {
    label: 'Payment provider · clearing',
    cash: 0n,
    coin: 0n,
  };
  private readonly outsideWorld: Wallet = { label: 'Outside world', cash: 0n, coin: 0n };
  /** Best (highest) first. */
  private readonly bids: Level[] = [];
  /** Best (lowest) first. */
  private readonly asks: Level[] = [];
  private readonly ledger: Transaction[] = [];
  private readonly tape: TradeRecord[] = [];
  private readonly buckets: Record<CandleInterval, Bucket[]> = { '1m': [], '5m': [], '1h': [] };
  private readonly pendingParties = new Set<Party>();
  private lastPrice = OPENING_PRICE;
  private lastTradeAt: number | null = null;
  private nextPartyId = 1;
  private nextOrderSeq = 1;
  private nextTradeId = 1;
  private nextEventId = 1;
  private nextTxId = 1;
  private lastStamp = 0;
  private actionAt: number | null = null;
  private lastTickAt: number | null = null;
  private lastSessionParty: Party | null = null;
  private botsActive = true;
  private botsTrading = true;
  private churn = 1;
  private fair = OPENING_PRICE;
  private regimeUntil = 0;
  private meanTradeMs = 4_000;

  constructor(opts: { clock: Clock; rng: Rng }) {
    this.clock = opts.clock;
    this.rng = opts.rng;
    const at = this.stamp();
    for (const name of BOT_NAMES) {
      const bot = this.addParty('bot', name, null, at);
      this.post(at, [
        [this.openingSource, 'USD', -BOT_CASH],
        [bot.wallet, 'USD', BOT_CASH],
        [this.openingSource, 'DFT', -BOT_COIN],
        [bot.wallet, 'DFT', BOT_COIN],
      ]);
      this.bots.push(bot);
    }
  }

  now(): number {
    return this.clock.now();
  }

  // ---------------------------------------------------------------- randomness
  private int(lo: number, hi: number): number {
    return lo + Math.floor(this.rng() * (hi - lo + 1));
  }

  private chance(p: number): boolean {
    return this.rng() < p;
  }

  private count(expected: number): number {
    const whole = Math.floor(expected);
    return whole + (this.rng() < expected - whole ? 1 : 0);
  }

  private hex(length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) out += this.int(0, 15).toString(16);
    return out;
  }

  private uuid(): string {
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-${'89ab'.charAt(this.int(0, 3))}${this.hex(3)}-${this.hex(12)}`;
  }

  /** Timestamps never run backwards, even when a client call lands between two ticks. */
  private stamp(): number {
    const t = Math.max(this.actionAt ?? this.clock.now(), this.lastStamp);
    this.lastStamp = t;
    return t;
  }

  // ---------------------------------------------------------------- ledger
  private post(at: number, postings: Posting[]): void {
    let cash = 0n;
    let coin = 0n;
    for (const [, unit, delta] of postings) {
      if (unit === 'USD') cash += delta;
      else coin += delta;
    }
    if (cash !== 0n || coin !== 0n) throw new Error('Unbalanced ledger transaction');
    for (const [wallet, unit, delta] of postings) {
      if (unit === 'USD') wallet.cash += delta;
      else wallet.coin += delta;
    }
    this.ledger.push({ id: this.nextTxId++, at, postings });
    if (this.ledger.length > LEDGER_KEEP) this.ledger.shift();
  }

  // ---------------------------------------------------------------- participants
  private addParty(
    kind: ParticipantKind,
    displayName: string,
    handle: string | null,
    createdAt: number,
  ): Party {
    const party: Party = {
      id: this.nextPartyId++,
      kind,
      displayName,
      handle,
      createdAt,
      wallet: { label: displayName, cash: 0n, coin: 0n },
      reservedCash: 0n,
      reservedCoin: 0n,
      open: new Map(),
      closed: [],
      orderIds: new Set(),
      movementIds: new Set(),
      fills: [],
      contributions: {
        openingCredit: 0n,
        deposits: 0n,
        transfersIn: 0n,
        withdrawals: 0n,
        transfersOut: 0n,
      },
      pending: [],
      feed: [],
      lastPublishAt: 0,
      nextOrderNo: 1,
    };
    this.parties.set(party.id, party);
    if (handle !== null) this.byHandle.set(handle, party);
    const number = /^Guest (\d{4})/.exec(displayName)?.[1];
    if (number !== undefined) this.guestNumbers.add(number);
    return party;
  }

  private party(id: ParticipantId): Party {
    const party = this.parties.get(id);
    if (!party) throw new Error(`Unknown participant ${id}`);
    return party;
  }

  private cashFree(p: Party): bigint {
    return p.wallet.cash - p.reservedCash;
  }

  private coinFree(p: Party): bigint {
    return p.wallet.coin - p.reservedCoin;
  }

  createGuest(identity: Partial<GuestIdentity> = {}): ParticipantId {
    const at = this.stamp();
    let handle = identity.handle;
    if (handle === undefined || this.byHandle.has(handle)) {
      do handle = this.hex(10);
      while (this.byHandle.has(handle));
    }
    let name = identity.displayName;
    if (name === undefined) {
      let number: string;
      do number = String(this.int(1_000, 9_999));
      while (this.guestNumbers.has(number));
      name = `Guest ${number}`;
    }
    const guest = this.addParty('guest', name, handle, identity.createdAt ?? at);
    this.post(at, [
      [this.openingSource, 'USD', -GUEST_OPENING_CREDIT],
      [guest.wallet, 'USD', GUEST_OPENING_CREDIT],
    ]);
    guest.contributions.openingCredit = GUEST_OPENING_CREDIT;
    return guest.id;
  }

  guestIdentity(id: ParticipantId): GuestIdentity | null {
    const p = this.parties.get(id);
    if (!p || p.kind !== 'guest' || p.handle === null) return null;
    return { displayName: p.displayName, handle: p.handle, createdAt: p.createdAt };
  }

  participantIdByHandle(handle: string): ParticipantId | null {
    return this.byHandle.get(handle)?.id ?? null;
  }

  bindSession(token: string, id: ParticipantId): void {
    const p = this.party(id);
    this.sessions.set(token, p);
    this.lastSessionParty = p;
  }

  resolveSession(token: string): ParticipantId | null {
    return this.sessions.get(token)?.id ?? null;
  }

  endSession(token: string): void {
    const p = this.sessions.get(token);
    this.sessions.delete(token);
    if (p && p === this.lastSessionParty) {
      this.lastSessionParty = null;
      for (const other of this.sessions.values()) this.lastSessionParty = other;
    }
  }

  // ---------------------------------------------------------------- reads
  getMe(id: ParticipantId): Me {
    const p = this.party(id);
    const c = p.contributions;
    const net = c.openingCredit + c.deposits + c.transfersIn - c.withdrawals - c.transfersOut;
    return {
      participant: { displayName: p.displayName, kind: p.kind, createdAt: iso(p.createdAt) },
      symbol: SYMBOL,
      startingCash: formatCash(c.openingCredit),
      handle: p.handle ?? '',
      netContributed: formatCash(net),
      contributions: {
        openingCredit: formatCash(c.openingCredit),
        deposits: formatCash(c.deposits),
        transfersIn: formatCash(c.transfersIn),
        withdrawals: formatCash(c.withdrawals),
        transfersOut: formatCash(c.transfersOut),
      },
      pendingEvents: p.pending.length,
      balances: {
        cash: formatCash(p.wallet.cash),
        cashAvailable: formatCash(this.cashFree(p)),
        asset: formatQty(p.wallet.coin),
        assetAvailable: formatQty(this.coinFree(p)),
      },
      openOrders: this.openOrdersOf(p)
        .slice(0, 100)
        .map((o) => orderWire(o, true)),
    };
  }

  private openOrdersOf(p: Party): Order[] {
    return [...p.open.values()].sort((a, b) => b.seq - a.seq);
  }

  listOrders(id: ParticipantId, status: 'open' | 'all', limit: number): ExchangeOrder[] {
    const p = this.party(id);
    const orders =
      status === 'open'
        ? this.openOrdersOf(p)
        : [...p.open.values(), ...p.closed].sort((a, b) => b.seq - a.seq);
    return orders.slice(0, limit).map((o) => orderWire(o, true));
  }

  listFills(id: ParticipantId, limit: number): OwnFill[] {
    return this.party(id)
      .fills.slice(-limit)
      .reverse()
      .map((f) => ({
        tradeId: String(f.tradeId),
        clientOrderId: f.clientOrderId,
        symbol: SYMBOL,
        side: f.side,
        liquidity: f.liquidity,
        price: formatCash(f.price),
        quantity: formatQty(f.quantity),
        notional: formatCash(f.cost),
        createdAt: iso(f.at),
        counterparty: f.counterparty,
      }));
  }

  getActivity(id: ParticipantId, limit: number): ActivityResponse {
    const p = this.party(id);
    return {
      pending: p.pending.length,
      events: p.feed
        .slice(-limit)
        .reverse()
        .map((e) => ({
          id: String(e.id),
          type: e.type,
          occurredAt: iso(e.occurredAt),
          publishedAt: iso(e.publishedAt),
          amount: e.amount === null ? null : formatCash(e.amount),
          symbol: e.quantity === null ? null : SYMBOL,
          side: e.side,
          liquidity: e.liquidity,
          price: e.price === null ? null : formatCash(e.price),
          quantity: e.quantity === null ? null : formatQty(e.quantity),
          counterparty: e.counterparty,
          reference: e.reference,
          entries: e.entries,
        })),
    };
  }

  getMarket(depth: number, tape: number): MarketSnapshot {
    const levels = (book: Level[]) =>
      book.slice(0, depth).map((level) => {
        let quantity = 0n;
        for (const o of level.orders) quantity += remaining(o);
        return {
          price: formatCash(level.price),
          quantity: formatQty(quantity),
          orders: level.orders.length,
        };
      });
    return {
      market: {
        symbol: SYMBOL,
        displayName: MARKET_NAME,
        tickSize: formatCash(TICK),
        lotSize: formatQty(LOT),
        minPrice: formatCash(MIN_PRICE),
        maxPrice: formatCash(MAX_PRICE),
        openingPrice: formatCash(OPENING_PRICE),
        lastPrice: formatCash(this.lastPrice),
        lastTradeAt: this.lastTradeAt === null ? null : iso(this.lastTradeAt),
      },
      stats: this.dayStats(),
      book: { bids: levels(this.bids), asks: levels(this.asks) },
      tape: this.tape
        .slice(-tape)
        .reverse()
        .map((t) => ({
          id: String(t.id),
          price: formatCash(t.price),
          quantity: formatQty(t.quantity),
          takerSide: t.takerSide,
          createdAt: iso(t.at),
        })),
    };
  }

  /** Trailing 24 h at one-minute resolution: a minute bucket counts when it starts inside the window. */
  private dayStats(): DayStats {
    const since = Math.floor((this.clock.now() - DAY_MS) / 1_000);
    let open: bigint | null = null;
    let high = 0n;
    let low = 0n;
    let volume = 0n;
    let trades = 0;
    for (const b of this.buckets['1m']) {
      if (b.time < since) continue;
      if (open === null) {
        open = b.open;
        high = b.high;
        low = b.low;
      }
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      volume += b.volume;
      trades += b.trades;
    }
    return {
      open: open === null ? null : formatCash(open),
      high: open === null ? null : formatCash(high),
      low: open === null ? null : formatCash(low),
      volume: formatQty(volume),
      trades,
    };
  }

  getCandles(interval: CandleInterval, limit: number): CandlesResponse {
    return {
      interval,
      intervalSeconds: CANDLES[interval].seconds,
      candles: this.buckets[interval].slice(-limit).map((b) => ({
        time: b.time,
        open: formatCash(b.open),
        high: formatCash(b.high),
        low: formatCash(b.low),
        close: formatCash(b.close),
        volume: formatQty(b.volume),
      })),
    };
  }

  bestPrices(): { bid: bigint | null; ask: bigint | null } {
    return { bid: this.bids[0]?.price ?? null, ask: this.asks[0]?.price ?? null };
  }

  // ---------------------------------------------------------------- orders
  private parseOrder(p: Party, request: PlaceOrderRequest): ParsedOrder | EngineFailure {
    if (p.orderIds.has(request.clientOrderId)) {
      return failure(
        409,
        'duplicate_order',
        `An order with clientOrderId "${request.clientOrderId}" already exists.`,
      );
    }
    const quantity = parseScaled(request.quantity, 8);
    if (quantity === null || quantity <= 0n || quantity % LOT !== 0n || quantity > MAX_ORDER_QTY) {
      return failure(
        422,
        'invalid_quantity',
        'Quantity must be a positive multiple of 0.01, at most 100000.',
      );
    }
    let limitPrice: bigint | null = null;
    if (request.type === 'limit') {
      limitPrice = parseScaled(request.limitPrice, 2);
      if (
        limitPrice === null ||
        limitPrice % TICK !== 0n ||
        limitPrice < MIN_PRICE ||
        limitPrice > MAX_PRICE
      ) {
        return failure(
          422,
          'invalid_price',
          'Price must be a multiple of 0.01 between 1.00 and 10000.00.',
        );
      }
      if (p.kind === 'guest' && p.open.size >= MAX_OPEN_ORDERS) {
        return failure(
          422,
          'too_many_open_orders',
          `You already have ${MAX_OPEN_ORDERS} open orders.`,
        );
      }
    }
    return {
      type: request.type,
      side: request.side,
      clientOrderId: request.clientOrderId,
      quantity,
      limitPrice,
    };
  }

  checkOrder(id: ParticipantId, request: PlaceOrderRequest): EngineFailure | null {
    const p = this.party(id);
    const parsed = this.parseOrder(p, request);
    if ('ok' in parsed) return parsed;
    return this.fundsFailure(p, parsed);
  }

  orderRequirement(id: ParticipantId, request: PlaceOrderRequest): OrderRequirement {
    const p = this.party(id);
    const quantity = parseScaled(request.quantity, 8) ?? 0n;
    if (request.side === 'sell') {
      return {
        unit: SYMBOL,
        available: formatQty(this.coinFree(p)),
        required: formatQty(quantity),
      };
    }
    const price = request.type === 'limit' ? parseScaled(request.limitPrice, 2) : null;
    const required = price === null ? this.sweepCost(p, quantity) : notional(price, quantity);
    return { unit: 'USD', available: formatCash(this.cashFree(p)), required: formatCash(required) };
  }

  placeOrder(id: ParticipantId, request: PlaceOrderRequest): EngineResult<PlacedOrder> {
    const p = this.party(id);
    const parsed = this.parseOrder(p, request);
    if ('ok' in parsed) return parsed;
    const result = this.submit(p, parsed);
    if (!result.ok) return result;
    return {
      ok: true,
      value: { order: orderWire(result.value.order, false), fills: result.value.fills },
    };
  }

  cancelOrder(id: ParticipantId, clientOrderId: string): EngineResult<{ status: 'cancelled' }> {
    const p = this.party(id);
    const order = p.open.get(clientOrderId);
    if (!order) {
      if (p.orderIds.has(clientOrderId)) {
        return failure(
          409,
          'order_not_open',
          `Order "${clientOrderId}" is already filled or cancelled.`,
        );
      }
      return failure(404, 'unknown_order', `No order with clientOrderId "${clientOrderId}".`);
    }
    this.cancelOpen(order, 'user', this.stamp());
    return { ok: true, value: { status: 'cancelled' } };
  }

  /** The first maker an incoming order could trade with, skipping the owner's own resting orders. */
  private firstFillable(p: Party, side: Side): Order | null {
    for (const level of side === 'buy' ? this.asks : this.bids) {
      for (const o of level.orders) if (o.owner !== p) return o;
    }
    return null;
  }

  private sweepCost(p: Party, quantity: bigint): bigint {
    let left = quantity;
    let cost = 0n;
    for (const level of this.asks) {
      for (const o of level.orders) {
        if (left === 0n) return cost;
        if (o.owner === p) continue;
        const q = minBig(left, remaining(o));
        cost += notional(level.price, q);
        left -= q;
      }
    }
    return cost;
  }

  private fundsFailure(p: Party, o: ParsedOrder): EngineFailure | null {
    if (o.type === 'market') {
      const first = this.firstFillable(p, o.side);
      if (!first)
        return failure(
          422,
          'no_liquidity',
          'There is nothing on the other side of the book to fill against.',
        );
      if (o.side === 'buy') {
        if (affordableQty(this.cashFree(p), first.limitPrice ?? 0n, LOT) === 0n) {
          return insufficient(
            'USD',
            formatCash(this.cashFree(p)),
            formatCash(this.sweepCost(p, o.quantity)),
          );
        }
      } else if (o.quantity > this.coinFree(p)) {
        return insufficient(SYMBOL, formatQty(this.coinFree(p)), formatQty(o.quantity));
      }
      return null;
    }
    if (o.side === 'buy') {
      const required = notional(o.limitPrice ?? 0n, o.quantity);
      if (required > this.cashFree(p))
        return insufficient('USD', formatCash(this.cashFree(p)), formatCash(required));
    } else if (o.quantity > this.coinFree(p)) {
      return insufficient(SYMBOL, formatQty(this.coinFree(p)), formatQty(o.quantity));
    }
    return null;
  }

  private submit(p: Party, o: ParsedOrder): EngineResult<{ order: Order; fills: Fill[] }> {
    const refused = this.fundsFailure(p, o);
    if (refused) return refused;
    const at = this.stamp();
    const order: Order = {
      seq: this.nextOrderSeq++,
      owner: p,
      clientOrderId: o.clientOrderId,
      side: o.side,
      type: o.type,
      limitPrice: o.limitPrice,
      quantity: o.quantity,
      filled: 0n,
      status: 'open',
      cancelReason: null,
      createdAt: at,
      updatedAt: at,
    };
    const fills: Fill[] = [];
    const stop = this.match(order, fills, at);
    // A market order that trades nothing leaves no row behind.
    if (order.type === 'market' && order.filled === 0n) {
      return stop === 'funds'
        ? insufficient(
            'USD',
            formatCash(this.cashFree(p)),
            formatCash(this.sweepCost(p, o.quantity)),
          )
        : failure(
            422,
            'no_liquidity',
            'There is nothing on the other side of the book to fill against.',
          );
    }
    if (p.kind === 'guest') p.orderIds.add(order.clientOrderId);
    const rest = remaining(order);
    if (rest === 0n) this.close(order, 'filled', null, at);
    else if (order.type === 'market')
      this.close(order, 'cancelled', stop === 'funds' ? 'insufficient_funds' : 'no_liquidity', at);
    else if (order.side === 'buy' && notional(order.limitPrice ?? 0n, rest) > this.cashFree(p)) {
      // Per-fill rounding left the remainder a cent short of its reservation.
      this.close(order, 'cancelled', 'insufficient_funds', at);
    } else this.rest(order);
    return { ok: true, value: { order, fills } };
  }

  /** Price-time priority against the opposite side; the owner's own resting orders are skipped and left resting. */
  private match(taker: Order, fills: Fill[], at: number): MatchStop {
    const book = taker.side === 'buy' ? this.asks : this.bids;
    let li = 0;
    let stop: MatchStop = 'exhausted';
    outer: while (remaining(taker) > 0n && li < book.length) {
      const level = book[li]!;
      const limit = taker.limitPrice;
      if (limit !== null && (taker.side === 'buy' ? level.price > limit : level.price < limit)) {
        stop = 'limit';
        break;
      }
      let oi = 0;
      while (oi < level.orders.length && remaining(taker) > 0n) {
        const maker = level.orders[oi]!;
        if (maker.owner === taker.owner) {
          oi++;
          continue;
        }
        let q = minBig(remaining(taker), remaining(maker));
        if (taker.side === 'buy') {
          const free = this.cashFree(taker.owner);
          if (notional(level.price, q) > free) {
            q = affordableQty(free, level.price, LOT);
            if (q === 0n) {
              stop = 'funds';
              break outer;
            }
          }
        } else if (!this.makerCanPay(maker, q)) {
          oi++;
          continue;
        }
        this.execute(taker, maker, level.price, q, at, fills);
        if (remaining(maker) === 0n) {
          level.orders.splice(oi, 1);
          this.close(maker, 'filled', null, at);
        } else oi++;
      }
      if (level.orders.length === 0) book.splice(li, 1);
      else li++;
    }
    return remaining(taker) === 0n ? 'filled' : stop;
  }

  /**
   * Fills round half up per fill, so two partial fills of a resting buy can cost a cent more than its
   * reservation released. Such a maker is skipped (like a self-trade) rather than driving cashAvailable negative.
   */
  private makerCanPay(maker: Order, q: bigint): boolean {
    const price = maker.limitPrice ?? 0n;
    const release = notional(price, remaining(maker)) - notional(price, remaining(maker) - q);
    return this.cashFree(maker.owner) + release - notional(price, q) >= 0n;
  }

  private execute(
    taker: Order,
    maker: Order,
    price: bigint,
    q: bigint,
    at: number,
    fills: Fill[],
  ): void {
    const buy = taker.side === 'buy' ? taker : maker;
    const sell = taker.side === 'buy' ? maker : taker;
    const buyer = buy.owner;
    const seller = sell.owner;
    const cost = notional(price, q);
    if (maker === buy) {
      const limit = buy.limitPrice ?? 0n;
      buyer.reservedCash -= notional(limit, remaining(buy)) - notional(limit, remaining(buy) - q);
    } else seller.reservedCoin -= q;
    this.post(at, [
      [buyer.wallet, 'USD', -cost],
      [seller.wallet, 'USD', cost],
      [seller.wallet, 'DFT', -q],
      [buyer.wallet, 'DFT', q],
    ]);
    buy.filled += q;
    sell.filled += q;
    buy.updatedAt = at;
    sell.updatedAt = at;
    const tradeId = this.recordTrade(price, q, taker.side, at);
    fills.push({ price: formatCash(price), quantity: formatQty(q), notional: formatCash(cost) });
    this.recordFill(buy, tradeId, price, q, cost, seller, taker === buy ? 'taker' : 'maker', at);
    this.recordFill(sell, tradeId, price, q, cost, buyer, taker === sell ? 'taker' : 'maker', at);
  }

  private recordFill(
    order: Order,
    tradeId: number,
    price: bigint,
    q: bigint,
    cost: bigint,
    other: Party,
    liquidity: Liquidity,
    at: number,
  ): void {
    const p = order.owner;
    if (p.kind !== 'guest') return;
    p.fills.push({
      tradeId,
      clientOrderId: order.clientOrderId,
      side: order.side,
      liquidity,
      price,
      quantity: q,
      cost,
      at,
      counterparty: other.displayName,
    });
    if (p.fills.length > HISTORY_KEEP) p.fills.shift();
    const cash = formatCash(cost);
    const coin = formatQty(q);
    const cp = other.displayName;
    const entries =
      order.side === 'buy'
        ? [
            entry('Your cash', 'debit', cash, 'USD'),
            entry(`${cp} · cash`, 'credit', cash, 'USD'),
            entry(`${cp} · ${SYMBOL}`, 'debit', coin, SYMBOL),
            entry(`Your ${SYMBOL}`, 'credit', coin, SYMBOL),
          ]
        : [
            entry(`Your ${SYMBOL}`, 'debit', coin, SYMBOL),
            entry(`${cp} · ${SYMBOL}`, 'credit', coin, SYMBOL),
            entry(`${cp} · cash`, 'debit', cash, 'USD'),
            entry('Your cash', 'credit', cash, 'USD'),
          ];
    this.emit(p, order.side === 'buy' ? 'trade.buy' : 'trade.sell', at, entries, {
      amount: cost,
      side: order.side,
      liquidity,
      price,
      quantity: q,
      counterparty: cp,
      reference: order.clientOrderId,
    });
  }

  private recordTrade(price: bigint, q: bigint, takerSide: Side, at: number): number {
    const id = this.nextTradeId++;
    this.tape.push({ id, price, quantity: q, takerSide, at });
    if (this.tape.length > TAPE_KEEP) this.tape.shift();
    this.lastPrice = price;
    this.lastTradeAt = at;
    const seconds = Math.floor(at / 1_000);
    for (const interval of Object.keys(CANDLES) as CandleInterval[]) {
      const spec = CANDLES[interval];
      const list = this.buckets[interval];
      const time = seconds - (seconds % spec.seconds);
      const last = list[list.length - 1];
      if (last && last.time === time) {
        if (price > last.high) last.high = price;
        if (price < last.low) last.low = price;
        last.close = price;
        last.volume += q;
        last.trades++;
      } else {
        list.push({
          time,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: q,
          trades: 1,
        });
        if (list.length > spec.keep) list.shift();
      }
    }
    return id;
  }

  private rest(order: Order): void {
    const p = order.owner;
    const price = order.limitPrice ?? 0n;
    if (order.side === 'buy') p.reservedCash += notional(price, remaining(order));
    else p.reservedCoin += remaining(order);
    p.open.set(order.clientOrderId, order);
    const book = order.side === 'buy' ? this.bids : this.asks;
    let lo = 0;
    let hi = book.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const lp = book[mid]!.price;
      if (lp === price) {
        book[mid]!.orders.push(order);
        return;
      }
      if (order.side === 'buy' ? lp > price : lp < price) lo = mid + 1;
      else hi = mid;
    }
    book.splice(lo, 0, { price, orders: [order] });
  }

  private unrest(order: Order): void {
    const book = order.side === 'buy' ? this.bids : this.asks;
    const li = book.findIndex((level) => level.price === order.limitPrice);
    const level = book[li];
    if (!level) return;
    const oi = level.orders.indexOf(order);
    if (oi >= 0) level.orders.splice(oi, 1);
    if (level.orders.length === 0) book.splice(li, 1);
  }

  private cancelOpen(order: Order, reason: CancelReason, at: number): void {
    const p = order.owner;
    if (order.side === 'buy') p.reservedCash -= notional(order.limitPrice ?? 0n, remaining(order));
    else p.reservedCoin -= remaining(order);
    this.unrest(order);
    this.close(order, 'cancelled', reason, at);
  }

  private close(order: Order, status: OrderStatus, reason: CancelReason | null, at: number): void {
    order.status = status;
    order.cancelReason = reason;
    order.updatedAt = at;
    const p = order.owner;
    p.open.delete(order.clientOrderId);
    if (p.kind !== 'guest') return;
    p.closed.push(order);
    if (p.closed.length > HISTORY_KEEP) p.closed.shift();
  }

  // ---------------------------------------------------------------- cash
  cashAvailable(id: ParticipantId): bigint {
    return this.cashFree(this.party(id));
  }

  deposit(id: ParticipantId, amount: bigint, deliveries: number): EngineResult<DepositResult> {
    const p = this.party(id);
    if (amount > MAX_DEPOSIT)
      return failure(422, 'amount_too_large', 'Deposits are limited to 10000.00 each.');
    const at = this.stamp();
    const depositId = `dep_${this.uuid()}`;
    this.post(at, [
      [this.providerClearing, 'USD', -amount],
      [p.wallet, 'USD', amount],
    ]);
    p.contributions.deposits += amount;
    const cash = formatCash(amount);
    this.emit(
      p,
      'deposit.credited',
      at,
      [
        entry(this.providerClearing.label, 'debit', cash, 'USD'),
        entry('Your cash', 'credit', cash, 'USD'),
      ],
      { amount, reference: depositId },
    );

    // The provider fires the same signed event `deliveries` times at once; the handler's idempotency
    // store lets exactly one through. With 5+, one copy lands mid-processing, gets 409 and is retried.
    const processed = this.int(1, deliveries);
    let toldToRetry = 0;
    if (deliveries >= 5) {
      do toldToRetry = this.int(1, deliveries);
      while (toldToRetry === processed);
    }
    const rows: DepositDelivery[] = [];
    for (let delivery = 1; delivery <= deliveries; delivery++) {
      if (delivery === processed) {
        rows.push({
          delivery,
          retry: 0,
          status: 200,
          outcome: 'processed',
          latencyMs: this.int(90, 180),
        });
      } else if (delivery === toldToRetry) {
        rows.push({
          delivery,
          retry: 0,
          status: 409,
          outcome: 'in_progress',
          latencyMs: this.int(12, 40),
        });
        rows.push({
          delivery,
          retry: 1,
          status: 200,
          outcome: 'duplicate',
          latencyMs: this.int(18, 60),
        });
      } else {
        rows.push({
          delivery,
          retry: 0,
          status: 200,
          outcome: 'duplicate',
          latencyMs: this.int(15, 70),
        });
      }
    }
    const tally = (outcome: string) => rows.filter((r) => r.outcome === outcome).length;
    return {
      ok: true,
      value: {
        depositId,
        amount: cash,
        credited: tally('processed') === 1,
        deliveries: rows,
        summary: {
          processed: tally('processed'),
          duplicates: tally('duplicate'),
          inProgress: tally('in_progress'),
          rejected: 0,
        },
        cashBalance: formatCash(p.wallet.cash),
      },
    };
  }

  private movementFailure(p: Party, clientId: string, amount: bigint): EngineFailure | null {
    if (p.movementIds.has(clientId)) {
      return failure(
        409,
        'duplicate_movement',
        `A movement with clientId "${clientId}" already exists.`,
      );
    }
    if (amount > MAX_MOVEMENT)
      return failure(
        422,
        'amount_too_large',
        'Withdrawals and transfers are limited to 1000000.00 each.',
      );
    if (amount > this.cashFree(p))
      return insufficient('USD', formatCash(this.cashFree(p)), formatCash(amount));
    return null;
  }

  withdraw(id: ParticipantId, clientId: string, amount: bigint): EngineResult<MovementResult> {
    const p = this.party(id);
    const refused = this.movementFailure(p, clientId, amount);
    if (refused) return refused;
    const at = this.stamp();
    p.movementIds.add(clientId);
    this.post(at, [
      [p.wallet, 'USD', -amount],
      [this.outsideWorld, 'USD', amount],
    ]);
    p.contributions.withdrawals += amount;
    const cash = formatCash(amount);
    this.emit(
      p,
      'withdrawal.completed',
      at,
      [
        entry('Your cash', 'debit', cash, 'USD'),
        entry(this.outsideWorld.label, 'credit', cash, 'USD'),
      ],
      { amount, reference: clientId },
    );
    return {
      ok: true,
      value: {
        status: 'completed',
        amount: cash,
        cashBalance: formatCash(p.wallet.cash),
        clientId,
        occurredAt: iso(at),
      },
    };
  }

  lookupRecipient(id: ParticipantId, handle: string): EngineResult<Recipient> {
    const p = this.party(id);
    const recipient = this.byHandle.get(handle);
    if (!recipient) return failure(404, 'unknown_recipient', `No guest has the handle ${handle}.`);
    if (recipient === p) return failure(422, 'self_transfer', 'That is your own handle.');
    return { ok: true, value: { handle, displayName: recipient.displayName } };
  }

  transfer(
    id: ParticipantId,
    clientId: string,
    amount: bigint,
    toHandle: string,
  ): EngineResult<MovementResult> {
    const p = this.party(id);
    const found = this.lookupRecipient(id, toHandle);
    if (!found.ok) return found;
    const refused = this.movementFailure(p, clientId, amount);
    if (refused) return refused;
    const recipient = this.byHandle.get(toHandle);
    if (!recipient)
      return failure(404, 'unknown_recipient', `No guest has the handle ${toHandle}.`);
    const at = this.stamp();
    this.moveCash(p, recipient, amount, clientId, at);
    return {
      ok: true,
      value: {
        status: 'completed',
        amount: formatCash(amount),
        cashBalance: formatCash(p.wallet.cash),
        clientId,
        occurredAt: iso(at),
      },
    };
  }

  private moveCash(from: Party, to: Party, amount: bigint, clientId: string, at: number): void {
    from.movementIds.add(clientId);
    this.post(at, [
      [from.wallet, 'USD', -amount],
      [to.wallet, 'USD', amount],
    ]);
    from.contributions.transfersOut += amount;
    to.contributions.transfersIn += amount;
    const cash = formatCash(amount);
    this.emit(
      from,
      'transfer.sent',
      at,
      [
        entry('Your cash', 'debit', cash, 'USD'),
        entry(`${to.displayName} · cash`, 'credit', cash, 'USD'),
      ],
      { amount, counterparty: to.displayName, reference: clientId },
    );
    this.emit(
      to,
      'transfer.received',
      at,
      [
        entry(`${from.displayName} · cash`, 'debit', cash, 'USD'),
        entry('Your cash', 'credit', cash, 'USD'),
      ],
      { amount, counterparty: from.displayName, reference: clientId },
    );
  }

  // ---------------------------------------------------------------- activity outbox
  // Entry convention: debit = the account the amount leaves, credit = the account it arrives in.
  private emit(
    p: Party,
    type: string,
    at: number,
    entries: LedgerEntry[],
    fields: EventFields,
  ): void {
    if (p.kind !== 'guest') return;
    const delay = this.chance(0.08) ? this.int(2_500, 8_000) : this.int(300, 2_500);
    const publishAt = Math.max(at + delay, p.lastPublishAt);
    p.lastPublishAt = publishAt;
    p.pending.push({
      id: this.nextEventId++,
      type,
      occurredAt: at,
      publishAt,
      publishedAt: 0,
      amount: fields.amount ?? null,
      side: fields.side ?? null,
      liquidity: fields.liquidity ?? null,
      price: fields.price ?? null,
      quantity: fields.quantity ?? null,
      counterparty: fields.counterparty ?? null,
      reference: fields.reference ?? null,
      entries,
    });
    this.pendingParties.add(p);
  }

  private publish(now: number, previousTick: number): void {
    for (const p of this.pendingParties) {
      let floor = p.feed[p.feed.length - 1]?.publishedAt ?? 0;
      while (p.pending.length > 0) {
        const event = p.pending[0]!;
        if (event.publishAt > now) break;
        p.pending.shift();
        event.publishedAt = Math.max(event.publishAt > previousTick ? event.publishAt : now, floor);
        floor = event.publishedAt;
        p.feed.push(event);
        if (p.feed.length > HISTORY_KEEP) p.feed.shift();
      }
      if (p.pending.length === 0) this.pendingParties.delete(p);
    }
  }

  // ---------------------------------------------------------------- background
  tick(nowMs: number, opts: TickOptions = {}): void {
    const previous = this.lastTickAt ?? nowMs;
    const simulated = Math.min(Math.max(0, nowMs - previous), MAX_CATCHUP_MS);
    if (this.botsActive && simulated > 0) this.runBots(nowMs - simulated, nowMs);
    if (opts.publish !== false) this.publish(nowMs, previous);
    this.lastTickAt = Math.max(nowMs, previous);
  }

  configureBots(opts: { active?: boolean; trading?: boolean; churn?: number }): void {
    if (opts.active !== undefined) this.botsActive = opts.active;
    if (opts.trading !== undefined) this.botsTrading = opts.trading;
    if (opts.churn !== undefined) this.churn = opts.churn;
  }

  private runBots(from: number, to: number): void {
    const span = to - from;
    if (to >= this.regimeUntil) {
      this.meanTradeMs = this.chance(0.15) ? this.int(45_000, 150_000) : this.int(2_000, 6_000);
      this.regimeUntil = to + this.int(3, 12) * 60_000;
    }
    const actions: { at: number; kind: 'quote' | 'trade' | 'drift' | 'gift' }[] = [];
    const schedule = (n: number, kind: 'quote' | 'trade' | 'drift' | 'gift') => {
      for (let i = 0; i < n; i++) actions.push({ at: from + Math.ceil(this.rng() * span), kind });
    };
    schedule(this.count(span * QUOTE_ACTIONS_PER_MS * this.churn), 'quote');
    if (this.botsTrading) schedule(this.count(span / this.meanTradeMs), 'trade');
    schedule(this.count(span * FAIR_STEPS_PER_MS), 'drift');
    if (this.lastSessionParty) schedule(this.count(span * INBOUND_PER_MS), 'gift');
    actions.sort((a, b) => a.at - b.at);
    for (const action of actions) {
      this.actionAt = action.at;
      if (action.kind === 'quote') this.botQuote(this.bots[this.int(0, this.bots.length - 1)]!);
      else if (action.kind === 'trade') this.botTrade();
      else if (action.kind === 'drift') this.drift();
      else this.inboundTransfer();
    }
    this.actionAt = null;
  }

  private drift(): void {
    const d = this.fair - FAIR_CENTER;
    const up = d > 10n ? 0.3 : d > 0n ? 0.45 : d < -10n ? 0.7 : d < 0n ? 0.55 : 0.5;
    this.fair += this.chance(up) ? TICK : -TICK;
    if (this.fair < FAIR_MIN) this.fair = FAIR_MIN;
    if (this.fair > FAIR_MAX) this.fair = FAIR_MAX;
  }

  private botOrderId(bot: Party): string {
    return `bot-${bot.displayName.toLowerCase()}-${bot.nextOrderNo++}`;
  }

  private botQuote(bot: Party): void {
    let stale: Order | null = null;
    let staleness = 0n;
    for (const o of bot.open.values()) {
      const d =
        o.side === 'buy' ? this.fair - (o.limitPrice ?? 0n) : (o.limitPrice ?? 0n) - this.fair;
      const score = d < 1n ? 1_000n - d : d > QUOTE_LEVELS ? d : 0n;
      if (score > staleness) {
        stale = o;
        staleness = score;
      }
    }
    const at = this.stamp();
    if (stale) this.cancelOpen(stale, 'user', at);
    else if (bot.open.size > 0 && this.chance(0.5)) {
      const list = [...bot.open.values()];
      this.cancelOpen(list[this.int(0, list.length - 1)]!, 'user', at);
    }
    for (let placed = 0; placed < 3 && bot.open.size < BOT_QUOTES; placed++) this.placeQuote(bot);
  }

  private placeQuote(bot: Party): void {
    let buys = 0;
    for (const o of bot.open.values()) if (o.side === 'buy') buys++;
    const sells = bot.open.size - buys;
    const side: Side =
      buys < sells ? 'buy' : sells < buys ? 'sell' : this.chance(0.5) ? 'buy' : 'sell';
    const k = BigInt(this.int(1, QUOTE_LEVEL_COUNT));
    let price = side === 'buy' ? this.fair - k : this.fair + k;
    const { bid, ask } = this.bestPrices();
    if (side === 'buy' && ask !== null && price >= ask) price = ask - TICK;
    if (side === 'sell' && bid !== null && price <= bid) price = bid + TICK;
    if (price < MIN_PRICE || price > MAX_PRICE) return;
    const r = this.rng();
    const lots = 300 + Math.floor(r * r * 14_700);
    this.submit(bot, {
      type: 'limit',
      side,
      clientOrderId: this.botOrderId(bot),
      quantity: BigInt(lots) * LOT,
      limitPrice: price,
    });
  }

  private botTrade(): void {
    const bot = this.bots[this.int(0, this.bots.length - 1)]!;
    const gap = this.fair - this.lastPrice;
    const pBuy = gap > 2n ? 0.8 : gap > 0n ? 0.65 : gap === 0n ? 0.5 : gap >= -2n ? 0.35 : 0.2;
    const r = this.rng();
    const lots = 50 + Math.floor(r * r * r * 1_950);
    this.submit(bot, {
      type: 'market',
      side: this.chance(pBuy) ? 'buy' : 'sell',
      clientOrderId: this.botOrderId(bot),
      quantity: BigInt(lots) * LOT,
      limitPrice: null,
    });
  }

  private inboundTransfer(): void {
    const target = this.lastSessionParty;
    if (!target) return;
    const amount = BigInt(this.int(500, 4_000));
    const donors: Party[] = [];
    for (const p of this.parties.values()) {
      if (p.kind === 'guest' && p !== target && this.cashFree(p) >= amount) donors.push(p);
    }
    const donor = donors[this.int(0, donors.length - 1)];
    if (!donor) return;
    this.moveCash(donor, target, amount, `gift-${target.id}-${donor.nextOrderNo++}`, this.stamp());
  }

  // ---------------------------------------------------------------- seeding hooks (not part of the seam)
  private botNamed(name: string): Party | null {
    return this.bots.find((b) => b.displayName === name) ?? null;
  }

  replenishBotQuotes(): void {
    for (const bot of this.bots) while (bot.open.size < BOT_QUOTES) this.placeQuote(bot);
  }

  cancelBotOrders(side: Side | 'both'): void {
    const at = this.stamp();
    for (const bot of this.bots) {
      for (const o of [...bot.open.values()])
        if (side === 'both' || o.side === side) this.cancelOpen(o, 'user', at);
    }
  }

  placeBotLimit(
    name: string,
    side: Side,
    quantity: bigint,
    limitPrice: bigint,
  ): EngineResult<unknown> {
    const bot = this.botNamed(name);
    if (!bot) return failure(404, 'unknown_participant', `No bot named ${name}.`);
    return this.submit(bot, {
      type: 'limit',
      side,
      clientOrderId: this.botOrderId(bot),
      quantity,
      limitPrice,
    });
  }

  /** A bot trades `quantity` against one specific resting order, sweeping whatever has priority ahead of it. */
  hitOrder(
    name: string,
    target: ParticipantId,
    clientOrderId: string,
    quantity: bigint,
  ): EngineResult<unknown> {
    const bot = this.botNamed(name);
    const order = this.party(target).open.get(clientOrderId);
    if (!bot || !order || order.limitPrice === null)
      return failure(404, 'unknown_order', `Cannot hit ${clientOrderId}.`);
    let ahead = 0n;
    scan: for (const level of order.side === 'buy' ? this.bids : this.asks) {
      for (const o of level.orders) {
        if (o === order) break scan;
        if (o.owner !== bot) ahead += remaining(o);
      }
    }
    return this.submit(bot, {
      type: 'limit',
      side: opposite(order.side),
      clientOrderId: this.botOrderId(bot),
      quantity: ahead + quantity,
      limitPrice: order.limitPrice,
    });
  }

  // ---------------------------------------------------------------- audit
  audit(): AuditReport {
    const problems: string[] = [];
    let cash = 0n;
    let coin = 0n;
    for (const w of [this.openingSource, this.providerClearing, this.outsideWorld]) {
      cash += w.cash;
      coin += w.coin;
    }
    for (const p of this.parties.values()) {
      cash += p.wallet.cash;
      coin += p.wallet.coin;
    }
    if (cash !== 0n) problems.push(`cash is not conserved (off by ${formatCash(cash)})`);
    if (coin !== 0n) problems.push(`coin is not conserved (off by ${formatQty(coin)})`);
    for (const tx of this.ledger) {
      let c = 0n;
      let q = 0n;
      for (const [, unit, delta] of tx.postings) {
        if (unit === 'USD') c += delta;
        else q += delta;
      }
      if (c !== 0n || q !== 0n) problems.push(`transaction ${tx.id} is unbalanced`);
    }

    const inBook = new Set<Order>();
    for (const [side, book] of [
      ['buy', this.bids],
      ['sell', this.asks],
    ] as const) {
      for (let i = 0; i < book.length; i++) {
        const level = book[i]!;
        const prev = book[i - 1];
        if (prev && (side === 'buy' ? prev.price <= level.price : prev.price >= level.price)) {
          problems.push(`${side} levels out of order at ${formatCash(level.price)}`);
        }
        if (level.orders.length === 0)
          problems.push(`empty ${side} level at ${formatCash(level.price)}`);
        for (const o of level.orders) {
          if (
            o.side !== side ||
            o.limitPrice !== level.price ||
            o.status !== 'open' ||
            remaining(o) <= 0n
          ) {
            problems.push(`order ${o.clientOrderId} misplaced in the book`);
          }
          if (o.owner.open.get(o.clientOrderId) !== o)
            problems.push(`order ${o.clientOrderId} is in the book but not open`);
          inBook.add(o);
        }
      }
    }

    let openCount = 0;
    for (const p of this.parties.values()) {
      const who = p.displayName;
      if (p.wallet.cash < 0n) problems.push(`${who}: negative cash`);
      if (p.wallet.coin < 0n) problems.push(`${who}: negative coin`);
      if (p.reservedCash < 0n) problems.push(`${who}: negative cash reservation`);
      if (p.reservedCoin < 0n) problems.push(`${who}: negative coin reservation`);
      if (this.cashFree(p) < 0n) problems.push(`${who}: reserved cash exceeds cash`);
      if (this.coinFree(p) < 0n) problems.push(`${who}: reserved coin exceeds coin`);
      let impliedCash = 0n;
      let impliedCoin = 0n;
      for (const o of p.open.values()) {
        openCount++;
        if (!inBook.has(o))
          problems.push(`${who}: open order ${o.clientOrderId} missing from the book`);
        if (o.side === 'buy') impliedCash += notional(o.limitPrice ?? 0n, remaining(o));
        else impliedCoin += remaining(o);
      }
      if (impliedCash !== p.reservedCash)
        problems.push(
          `${who}: reserved cash ${formatCash(p.reservedCash)} ≠ open buys ${formatCash(impliedCash)}`,
        );
      if (impliedCoin !== p.reservedCoin)
        problems.push(
          `${who}: reserved coin ${formatQty(p.reservedCoin)} ≠ open sells ${formatQty(impliedCoin)}`,
        );
    }
    if (openCount !== inBook.size)
      problems.push(`book holds ${inBook.size} orders but ${openCount} are open`);
    return { ok: problems.length === 0, problems };
  }
}
