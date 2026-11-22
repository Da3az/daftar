import type { ActivityEvent, ExchangeOrder } from '@/api/types';
import { showCash, showQty } from '@/lib/money';
import { groupHandle, HANDLE_PATTERN } from '@/lib/ids';
import { SYMBOL } from '@/lib/rules';

const who = (name: string | null): string =>
  name ? (HANDLE_PATTERN.test(name) ? groupHandle(name) : name) : 'someone';

export interface Described {
  title: string;
  /** +1 money in, −1 money out, 0 unknown. */
  direction: 1 | -1 | 0;
  kind: 'trade' | 'deposit' | 'withdrawal' | 'transfer' | 'other';
}

/** A human sentence for each event type. The set is open: an unknown type is shown as it came, not hidden. */
export function describeEvent(event: ActivityEvent): Described {
  const qty = `${showQty(event.quantity)} ${event.symbol ?? SYMBOL}`;
  const role =
    event.liquidity === 'maker'
      ? 'your waiting order was taken'
      : event.liquidity === 'taker'
        ? 'you took a waiting order'
        : '';
  switch (event.type) {
    case 'trade.buy':
      return {
        title: `Bought ${qty} at ${showCash(event.price)} from ${who(event.counterparty)}${role ? ` — ${role}` : ''}`,
        direction: -1,
        kind: 'trade',
      };
    case 'trade.sell':
      return {
        title: `Sold ${qty} at ${showCash(event.price)} to ${who(event.counterparty)}${role ? ` — ${role}` : ''}`,
        direction: 1,
        kind: 'trade',
      };
    case 'deposit.credited':
      return { title: 'Deposit credited by the payment provider', direction: 1, kind: 'deposit' };
    case 'withdrawal.completed':
      return { title: 'Withdrawal completed', direction: -1, kind: 'withdrawal' };
    // The withdrawal saga. Only `held`/`review` and `released` move your cash;
    // the steps between move nothing and say so with direction 0.
    case 'withdrawal.held':
      return {
        title: 'Withdrawal requested — cash moved to hold',
        direction: -1,
        kind: 'withdrawal',
      };
    case 'withdrawal.review':
      return { title: 'Withdrawal waiting for a review', direction: -1, kind: 'withdrawal' };
    case 'withdrawal.approved':
      return { title: 'Withdrawal approved on review', direction: 0, kind: 'withdrawal' };
    case 'withdrawal.submitted':
      return { title: 'Withdrawal sent to the payout rail', direction: 0, kind: 'withdrawal' };
    case 'withdrawal.requeued':
      return {
        title: 'Withdrawal re-sent — the rail had no record of it',
        direction: 0,
        kind: 'withdrawal',
      };
    case 'withdrawal.confirmed':
      return { title: 'Withdrawal paid out', direction: 0, kind: 'withdrawal' };
    case 'withdrawal.released':
      return {
        title: 'Withdrawal failed — cash returned from hold',
        direction: 1,
        kind: 'withdrawal',
      };
    case 'transfer.sent':
      return { title: `Sent to ${who(event.counterparty)}`, direction: -1, kind: 'transfer' };
    case 'transfer.received':
      return { title: `Received from ${who(event.counterparty)}`, direction: 1, kind: 'transfer' };
    default:
      return {
        title: `${event.type || 'Unknown event'} (a kind this page does not know yet)`,
        direction: 0,
        kind: 'other',
      };
  }
}

const REASONS: Record<string, string> = {
  user: 'you cancelled it',
  insufficient_funds: 'not enough funds to continue',
  no_liquidity: 'nothing left to trade with',
  self_trade: 'a newer order of yours would have traded with it',
};

export function describeStatus(order: ExchangeOrder): {
  word: string;
  tone: 'open' | 'partial' | 'filled' | 'cancelled';
  reason: string | null;
} {
  const partly = order.filledQuantity && !/^0(\.0+)?$/.test(order.filledQuantity);
  if (order.status === 'open')
    return {
      word: partly ? 'waiting, partly filled' : 'waiting',
      tone: partly ? 'partial' : 'open',
      reason: null,
    };
  if (order.status === 'filled') return { word: 'filled', tone: 'filled', reason: null };
  if (order.status === 'cancelled')
    return {
      word: partly ? 'partly filled, rest cancelled' : 'cancelled',
      tone: 'cancelled',
      reason: order.cancelReason ? (REASONS[order.cancelReason] ?? order.cancelReason) : null,
    };
  return { word: String(order.status ?? '—'), tone: 'cancelled', reason: null };
}
