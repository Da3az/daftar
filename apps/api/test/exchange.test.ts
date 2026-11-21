import { beforeEach, describe, expect, it } from 'vitest';
import { parseCash, parseQuantity } from '@daftar/money';
import { useTestDatabase } from './support/test-database.ts';
import { resetLedger } from './support/reset.ts';
import { post } from '../src/ledger/post.ts';
import { CHECK_VIOLATION, sqlstateOf } from '../src/ledger/sqlstate.ts';
import {
  DEFAULT_MARKET,
  cancelBookOrder,
  placeBookOrder,
  type PlaceBookOrderRequest,
  type PlaceBookOrderResult,
} from '../src/exchange/engine.ts';
import { GUEST_STARTING_CASH, createGuest, ensureBots } from '../src/exchange/participants.ts';
import { getBalances, getBook, getMarket, listFills } from '../src/exchange/queries.ts';
import { issueGuestToken, readCookie, verifyGuestToken } from '../src/exchange/session.ts';

const ctx = useTestDatabase({ poolMax: 20 });

const SYMBOL = DEFAULT_MARKET;

let bots: string[] = [];
let sequence = 0;

beforeEach(async () => {
  await resetLedger(ctx.pool);

  // `markets` is reference data from migration 0011, and every trade moves its
  // last price. Reset it, for the reason `resetInstruments` exists.
  await ctx.pool.query('UPDATE markets SET last_price = opening_price, last_trade_at = NULL');

  bots = await ensureBots(ctx.pool, 2);
  sequence = 0;
});

type OrderInput = Pick<PlaceBookOrderRequest, 'side' | 'type'> & {
  quantity: string;
  limitPrice?: string;
};

const order = (participantExternalId: string, input: OrderInput): Promise<PlaceBookOrderResult> =>
  placeBookOrder(ctx.pool, {
    externalId: `${participantExternalId}:t-${String((sequence += 1))}`,
    participantExternalId,
    symbol: SYMBOL,
    side: input.side,
    type: input.type,
    quantity: parseQuantity(input.quantity),
    ...(input.limitPrice === undefined ? {} : { limitPrice: parseCash(input.limitPrice) }),
  });

/** Narrow to the accepted branch, failing with the refusal if it was one. */
function accepted(result: PlaceBookOrderResult) {
  if (result.status !== 'accepted') {
    throw new Error(`expected the order to be accepted, got ${result.status}`);
  }
  return result;
}

const balanceOf = async (externalId: string): Promise<bigint> => {
  const { rows } = await ctx.pool.query<{ balance: bigint }>(
    'SELECT balance FROM accounts WHERE external_id = $1',
    [externalId],
  );
  return rows[0]!.balance;
};

const participantId = async (externalId: string): Promise<bigint> => {
  const { rows } = await ctx.pool.query<{ id: bigint }>(
    'SELECT id FROM participants WHERE external_id = $1',
    [externalId],
  );
  return rows[0]!.id;
};

describe('entering as a guest', () => {
  it('funds the guest through the ledger, from the faucet', async () => {
    const guest = await createGuest(ctx.pool);

    expect(await balanceOf(guest.externalId)).toBe(GUEST_STARTING_CASH);
    expect(await balanceOf(`${guest.externalId}:${SYMBOL}`)).toBe(0n);
    // The faucet is short by exactly what it handed out, so the system nets to
    // zero rather than gaining 10,000.00 from nowhere.
    expect(await balanceOf('external:guest-faucet')).toBe(-GUEST_STARTING_CASH);

    const { rows } = await ctx.pool.query<{ legs: bigint; net: bigint }>(
      `SELECT count(*) AS legs, sum(amount)::bigint AS net
         FROM entries e JOIN accounts a ON a.id = e.account_id
        WHERE a.external_id IN ($1, 'external:guest-faucet')`,
      [guest.externalId],
    );
    expect(rows[0]!.legs).toBe(2n);
    expect(rows[0]!.net).toBe(0n);
  });
});

describe('matching', () => {
  it('rests a limit order that crosses nothing', async () => {
    const result = accepted(
      await order(bots[0]!, { side: 'sell', type: 'limit', quantity: '5', limitPrice: '26.00' }),
    );

    expect(result.order.status).toBe('open');
    expect(result.fills).toHaveLength(0);

    const book = await getBook(ctx.pool, SYMBOL, 5);
    expect(book.asks).toEqual([{ price: 2600n, quantity: parseQuantity('5'), orders: 1 }]);
    expect(book.bids).toHaveLength(0);
  });

  it('fills at the resting order’s price, not the incoming limit', async () => {
    await order(bots[0]!, { side: 'sell', type: 'limit', quantity: '5', limitPrice: '26.00' });
    const guest = await createGuest(ctx.pool);

    const result = accepted(
      await order(guest.externalId, {
        side: 'buy',
        type: 'limit',
        quantity: '2',
        limitPrice: '30.00',
      }),
    );

    expect(result.order.status).toBe('filled');
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.price).toBe(2600n);
    expect(result.fills[0]!.notional).toBe(5200n);

    expect(await balanceOf(guest.externalId)).toBe(GUEST_STARTING_CASH - 5200n);
    expect(await balanceOf(`${guest.externalId}:${SYMBOL}`)).toBe(parseQuantity('2'));
    expect((await getMarket(ctx.pool, SYMBOL))!.lastPrice).toBe(2600n);
  });

  it('takes the best price first, and the oldest order first within a price', async () => {
    const [first, second] = [bots[0]!, bots[1]!];

    await order(first, { side: 'sell', type: 'limit', quantity: '1', limitPrice: '26.00' });
    await order(second, { side: 'sell', type: 'limit', quantity: '1', limitPrice: '25.50' });
    await order(second, { side: 'sell', type: 'limit', quantity: '1', limitPrice: '26.00' });

    const guest = await createGuest(ctx.pool);
    const result = accepted(
      await order(guest.externalId, { side: 'buy', type: 'market', quantity: '2' }),
    );

    // 25.50 before either 26.00, then the 26.00 that arrived first.
    expect(result.fills.map((f) => f.price)).toEqual([2550n, 2600n]);

    const firstFills = await listFills(ctx.pool, await participantId(first), 10);
    expect(firstFills).toHaveLength(1);
    expect(firstFills[0]!.liquidity).toBe('maker');
  });

  it('cancels the unfilled remainder of a market order', async () => {
    await order(bots[0]!, { side: 'sell', type: 'limit', quantity: '1', limitPrice: '26.00' });
    const guest = await createGuest(ctx.pool);

    const result = accepted(
      await order(guest.externalId, { side: 'buy', type: 'market', quantity: '3' }),
    );

    expect(result.order.filledQuantity).toBe(parseQuantity('1'));
    expect(result.order.status).toBe('cancelled');
    expect(result.order.cancelReason).toBe('no_liquidity');
  });

  it('refuses a market order against an empty book and records nothing', async () => {
    const guest = await createGuest(ctx.pool);

    const result = await order(guest.externalId, { side: 'buy', type: 'market', quantity: '1' });
    expect(result.status).toBe('no_liquidity');

    const { rows } = await ctx.pool.query<{ count: bigint }>(
      'SELECT count(*) AS count FROM book_orders',
    );
    expect(rows[0]!.count).toBe(0n);
  });

  it('cancels a participant’s own resting order rather than trading with it', async () => {
    const bot = bots[0]!;
    await order(bot, { side: 'sell', type: 'limit', quantity: '1', limitPrice: '26.00' });

    const result = accepted(
      await order(bot, { side: 'buy', type: 'limit', quantity: '1', limitPrice: '27.00' }),
    );

    expect(result.fills).toHaveLength(0);
    expect(result.order.status).toBe('open');

    const { rows } = await ctx.pool.query<{ status: string; cancel_reason: string | null }>(
      `SELECT status, cancel_reason FROM book_orders WHERE side = 'sell'`,
    );
    expect(rows).toEqual([{ status: 'cancelled', cancel_reason: 'self_trade' }]);

    // And the book is not crossed against itself.
    const book = await getBook(ctx.pool, SYMBOL, 5);
    expect(book.asks).toHaveLength(0);
  });

  it('writes four entries per trade, balanced per unit', async () => {
    await order(bots[0]!, { side: 'sell', type: 'limit', quantity: '3', limitPrice: '25.01' });
    await order(bots[1]!, { side: 'sell', type: 'limit', quantity: '3', limitPrice: '25.03' });
    const guest = await createGuest(ctx.pool);
    await order(guest.externalId, { side: 'buy', type: 'market', quantity: '5' });

    const { rows: perTrade } = await ctx.pool.query<{ legs: bigint }>(
      `SELECT count(e.*) AS legs FROM trades t
         JOIN entries e ON e.transaction_id = t.transaction_id
        GROUP BY t.id`,
    );
    expect(perTrade).toHaveLength(2);
    expect(perTrade.every((r) => r.legs === 4n)).toBe(true);

    const { rows: perUnit } = await ctx.pool.query<{ unit: string; net: bigint }>(
      'SELECT unit, sum(amount)::bigint AS net FROM entries GROUP BY unit ORDER BY unit',
    );
    expect(perUnit).toEqual([
      { unit: SYMBOL, net: 0n },
      { unit: 'USD', net: 0n },
    ]);
  });
});

describe('funds', () => {
  it('lets a bot sell what it does not hold', async () => {
    await order(bots[0]!, { side: 'sell', type: 'limit', quantity: '10', limitPrice: '25.00' });
    const guest = await createGuest(ctx.pool);
    await order(guest.externalId, { side: 'buy', type: 'market', quantity: '10' });

    // Short ten coins: every coin the guest holds is one the bot owes.
    expect(await balanceOf(`${bots[0]!}:${SYMBOL}`)).toBe(-parseQuantity('10'));
  });

  it('refuses a guest sell of coins it does not hold', async () => {
    const guest = await createGuest(ctx.pool);

    const result = await order(guest.externalId, {
      side: 'sell',
      type: 'limit',
      quantity: '1',
      limitPrice: '25.00',
    });

    expect(result.status).toBe('insufficient_funds');
  });

  it('counts open buy orders against available cash', async () => {
    const guest = await createGuest(ctx.pool);

    // 300 x 20.00 = 6,000.00 of the 10,000.00.
    accepted(
      await order(guest.externalId, {
        side: 'buy',
        type: 'limit',
        quantity: '300',
        limitPrice: '20.00',
      }),
    );

    // A second 6,000.00 would be covered by the balance and not by what is left.
    const second = await order(guest.externalId, {
      side: 'buy',
      type: 'limit',
      quantity: '300',
      limitPrice: '20.00',
    });
    expect(second.status).toBe('insufficient_funds');

    const balances = await getBalances(
      ctx.pool,
      { id: await participantId(guest.externalId), externalId: guest.externalId },
      SYMBOL,
    );
    expect(balances.cash).toBe(GUEST_STARTING_CASH);
    expect(balances.cashAvailable).toBe(GUEST_STARTING_CASH - 600_000n);
  });

  it('fills a market buy only as far as the cash goes', async () => {
    // 1,000 coins at 25.00 is 25,000.00; the guest has 10,000.00.
    await order(bots[0]!, { side: 'sell', type: 'limit', quantity: '1000', limitPrice: '25.00' });
    const guest = await createGuest(ctx.pool);

    const result = accepted(
      await order(guest.externalId, { side: 'buy', type: 'market', quantity: '1000' }),
    );

    expect(result.order.filledQuantity).toBe(parseQuantity('400'));
    expect(result.order.cancelReason).toBe('insufficient_funds');
    expect(await balanceOf(guest.externalId)).toBe(0n);
  });

  it('withdraws a resting order its owner can no longer cover', async () => {
    const guest = await createGuest(ctx.pool);
    accepted(
      await order(guest.externalId, {
        side: 'buy',
        type: 'limit',
        quantity: '300',
        limitPrice: '20.00',
      }),
    );

    // Move the guest's cash away behind the exchange's back, the way the legacy
    // API could. The reservation is arithmetic, so only the ledger notices.
    const { rows } = await ctx.pool.query<{ external_id: string; id: bigint }>(
      `SELECT external_id, id FROM accounts
        WHERE external_id IN ($1, 'external:guest-faucet')`,
      [guest.externalId],
    );
    const id = (externalId: string) => rows.find((r) => r.external_id === externalId)!.id;
    await post(ctx.pool, {
      kind: 'adjustment',
      legs: [
        { accountId: id(guest.externalId), amount: -GUEST_STARTING_CASH },
        { accountId: id('external:guest-faucet'), amount: GUEST_STARTING_CASH },
      ],
      mode: 'advisory',
    });

    const result = accepted(
      await order(bots[0]!, { side: 'sell', type: 'limit', quantity: '1', limitPrice: '20.00' }),
    );

    // The bot's offer crosses the guest's bid, the ledger refuses the fill, and
    // the bid is withdrawn instead of the account being overdrawn.
    expect(result.fills).toHaveLength(0);
    expect(result.order.status).toBe('open');
    expect(await balanceOf(guest.externalId)).toBe(0n);

    const { rows: bids } = await ctx.pool.query<{ status: string; cancel_reason: string | null }>(
      `SELECT status, cancel_reason FROM book_orders WHERE side = 'buy'`,
    );
    expect(bids).toEqual([{ status: 'cancelled', cancel_reason: 'insufficient_funds' }]);
  });
});

describe('cancelling', () => {
  it('cancels an open order once, and only for its owner', async () => {
    const guest = await createGuest(ctx.pool);
    const other = await createGuest(ctx.pool);
    const placed = accepted(
      await order(guest.externalId, {
        side: 'buy',
        type: 'limit',
        quantity: '1',
        limitPrice: '20.00',
      }),
    );

    const cancel = (participantExternalId: string) =>
      cancelBookOrder(ctx.pool, {
        participantExternalId,
        orderExternalId: placed.order.externalId,
      });

    expect(await cancel(other.externalId)).toEqual({ status: 'not_found' });
    expect(await cancel(guest.externalId)).toEqual({ status: 'cancelled' });
    expect(await cancel(guest.externalId)).toEqual({ status: 'not_open', current: 'cancelled' });
  });
});

describe('order invariants are enforced by PostgreSQL', () => {
  const insertOrder = async (overrides: string): Promise<string | undefined> => {
    const bot = await participantId(bots[0]!);
    try {
      await ctx.pool.query(
        `INSERT INTO book_orders
           (external_id, participant_id, symbol, side, type, limit_price,
            quantity, filled_quantity, status, cancel_reason)
         VALUES ('raw-1', $1::bigint, $2, 'buy', ${overrides})`,
        [bot.toString(), SYMBOL],
      );
      return undefined;
    } catch (err) {
      return sqlstateOf(err);
    }
  };

  it('rejects a market order that rests', async () => {
    expect(await insertOrder(`'market', NULL, 100, 0, 'open', NULL`)).toBe(CHECK_VIOLATION);
  });

  it('rejects "filled" that the arithmetic does not agree with', async () => {
    expect(await insertOrder(`'limit', 2500, 100, 50, 'filled', NULL`)).toBe(CHECK_VIOLATION);
  });

  it('rejects a limit order with no price', async () => {
    expect(await insertOrder(`'limit', NULL, 100, 0, 'open', NULL`)).toBe(CHECK_VIOLATION);
  });

  it('rejects a market whose smallest fill could round to nothing', async () => {
    let code: string | undefined;
    try {
      await ctx.pool.query(
        `INSERT INTO markets
           (symbol, display_name, tick_size, lot_size, min_price, max_price,
            opening_price, last_price)
         VALUES ('TINY', 'Too small', 1, 1, 1, 100, 50, 50)`,
      );
    } catch (err) {
      code = sqlstateOf(err);
    }
    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe('guest session tokens', () => {
  const SECRET = 'a-test-secret-of-sufficient-length';
  const GUEST = 'guest-0123456789abcdef';

  it('round-trips, and rejects a different secret or subject', () => {
    const token = issueGuestToken(SECRET, GUEST);

    expect(verifyGuestToken(SECRET, token)).toBe(GUEST);
    expect(verifyGuestToken('a-different-secret-entirely', token)).toBeNull();
    expect(verifyGuestToken(SECRET, token.replace('0123', '9999'))).toBeNull();
    expect(verifyGuestToken(SECRET, 'no-separator')).toBeNull();
  });

  it('reads one cookie out of a header carrying several', () => {
    expect(readCookie('a=1; daftar_guest=xyz.abc; b=2', 'daftar_guest')).toBe('xyz.abc');
    expect(readCookie('a=1', 'daftar_guest')).toBeNull();
    expect(readCookie(undefined, 'daftar_guest')).toBeNull();
  });
});
