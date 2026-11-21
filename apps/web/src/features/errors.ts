import { ApiError, NetworkError } from '@/api/client';
import { showCash, showQty } from '@/lib/money';
import type { Tone } from '@/components/bits';

export interface Refusal {
  tone: Tone;
  title: string;
  detail: string;
  /** Which control it belongs next to. */
  field: 'price' | 'quantity' | 'amount' | 'recipient' | 'form';
  /** Seconds until a rate limit frees, when known. */
  retryAfter?: number | undefined;
}

const amount = (value: string | undefined, unit: string | undefined): string =>
  unit === 'USD' ? `${showCash(value)} USD` : `${showQty(value)} ${unit ?? ''}`.trim();

/** "14 s" up to a minute and a half, then whole minutes rounded up: "57 min". */
export function waitPhrase(seconds: number): string {
  return seconds > 90 ? `${Math.ceil(seconds / 60)} min` : `${Math.max(1, Math.ceil(seconds))} s`;
}

function rateLimited(error: ApiError, what: string): Refusal {
  const wait = error.body.retryAfterSeconds;
  return {
    tone: 'warning',
    field: 'form',
    title: 'Slow down a moment',
    detail: `${what}${wait ? ` Try again in ${waitPhrase(wait)}.` : ' Try again shortly.'}`,
    retryAfter: wait,
  };
}

const FIELD_OF: Record<string, Refusal['field']> = {
  quantity: 'quantity',
  limitPrice: 'price',
  amount: 'amount',
  toHandle: 'recipient',
};

/**
 * A 400 validation_failed, in words. The server names fields as JSON pointers
 * ("/quantity", "/" for the body itself); the leading slash is dropped, and a
 * refusal about a single known field is attached to that field.
 */
function validation(body: ApiError['body'], title: string): Refusal {
  const issues = (body.issues ?? []).map((issue) => ({
    path: issue.path.replace(/^\//, ''),
    message: issue.message,
  }));
  const fields = new Set(issues.map((issue) => FIELD_OF[issue.path] ?? 'form'));
  const only = fields.size === 1 ? [...fields][0] : undefined;
  const detail =
    issues
      .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
      .join(' · ') || body.message;
  return { tone: 'danger', field: only ?? 'form', title, detail };
}

const ORDER_LIMIT = 'Orders are limited to 120 a minute, and cancels to another 120.';
const CASH_LIMIT = 'Deposits, withdrawals and transfers are each limited to 30 a minute.';
const LOOKUP_LIMIT = 'Handle lookups are limited to 30 a minute, separately from sending.';
const noSession: Refusal = {
  tone: 'warning',
  field: 'form',
  title: 'This browser no longer has a session',
  detail:
    'The cookie is gone, so the account cannot be reached. Enter as a guest to start a new one.',
};

const unreachable: Refusal = {
  tone: 'warning',
  field: 'form',
  title: 'The server could not be reached',
  detail: 'Nothing was sent. Your entries are kept — try again.',
};
const serverFault = (what: string): Refusal => ({
  tone: 'danger',
  field: 'form',
  title: 'The server had a problem (500)',
  detail: `${what} Your entries are kept — try again.`,
});

/** Every refusal an order can get, in words, next to the control that caused it. */
export function describeOrderError(error: unknown, setAsideNote = ''): Refusal {
  if (error instanceof NetworkError) return unreachable;
  if (!(error instanceof ApiError)) return serverFault('The order was not placed.');
  if (error.status === 429) return rateLimited(error, ORDER_LIMIT);
  const { body } = error;
  switch (error.code) {
    case 'insufficient_funds':
      return {
        tone: 'danger',
        field: 'quantity',
        title: body.unit === 'USD' ? 'Not enough cash you can use' : 'Not enough coins you can use',
        detail: `This order needs ${amount(body.required, body.unit)} and you can use ${amount(body.available, body.unit)}.${setAsideNote}`,
      };
    case 'invalid_quantity':
      return {
        tone: 'danger',
        field: 'quantity',
        title: 'The server refused that quantity',
        detail:
          'It must be more than zero, in steps of 0.01, and at most 100,000 coins on one order.',
      };
    case 'invalid_price':
      return {
        tone: 'danger',
        field: 'price',
        title: 'The server refused that price',
        detail: 'It must be in steps of 0.01, between 1.00 and 10,000.00.',
      };
    case 'too_many_open_orders':
      return {
        tone: 'danger',
        field: 'form',
        title: '50 orders are already waiting',
        detail: 'That is the most one guest can have open. Cancel one to place another.',
      };
    case 'no_liquidity':
      return {
        tone: 'warning',
        field: 'form',
        title: 'Nothing to trade with right now',
        detail:
          'A market order takes what is already in the book, and that side is empty. A limit order can wait there instead.',
      };
    case 'duplicate_order':
      return {
        tone: 'info',
        field: 'form',
        title: 'That order was already received',
        detail: 'It was sent twice and counted once. Nothing was duplicated.',
      };
    case 'request_in_progress':
      return {
        tone: 'info',
        field: 'form',
        title: 'Still working on the first copy',
        detail:
          'The same order arrived again while it was being processed. It will be placed once.',
      };
    case 'idempotency_key_reused':
      return {
        tone: 'danger',
        field: 'form',
        title: 'That request id was used for a different order',
        detail: 'Nothing was placed. Submit again to send it under a new id.',
      };
    case 'validation_failed':
      return validation(body, 'The order did not match what the server expects');
    case 'not_a_guest':
      return noSession;
    case 'unknown_market':
      return {
        tone: 'danger',
        field: 'form',
        title: 'The server does not know this market',
        detail: body.message,
      };
    default:
      return serverFault('The order was not placed.');
  }
}

export function describeCancelError(error: unknown): Refusal {
  if (error instanceof NetworkError) return unreachable;
  if (!(error instanceof ApiError)) return serverFault('The order was not cancelled.');
  if (error.status === 429) return rateLimited(error, ORDER_LIMIT);
  switch (error.code) {
    case 'not_a_guest':
      return noSession;
    case 'order_not_open':
      return {
        tone: 'info',
        field: 'form',
        title: 'Already done',
        detail:
          'It filled or was cancelled before the cancel arrived. The list here was out of date.',
      };
    case 'unknown_order':
      return {
        tone: 'info',
        field: 'form',
        title: 'The server has no such order',
        detail: 'It may have been a market order that never rested. The list has been refreshed.',
      };
    default:
      return serverFault('The order was not cancelled.');
  }
}

export function describeCashError(
  error: unknown,
  kind: 'deposit' | 'withdrawal' | 'transfer' | 'lookup',
  setAsideNote = '',
): Refusal {
  if (error instanceof NetworkError) return unreachable;
  if (!(error instanceof ApiError)) return serverFault('No money moved.');
  if (error.code === 'deposit_limit')
    return {
      tone: 'warning',
      field: 'form',
      title: 'Ten deposits in the last hour',
      detail:
        'That is the hourly limit. No money moved. Try again when the oldest one is an hour old.',
    };
  if (error.status === 429)
    return rateLimited(error, kind === 'lookup' ? LOOKUP_LIMIT : CASH_LIMIT);
  const { body } = error;
  switch (error.code) {
    case 'amount_too_large':
      return {
        tone: 'danger',
        field: 'amount',
        title: 'That is over the limit',
        detail:
          kind === 'deposit'
            ? 'One deposit can be at most 10,000.00.'
            : `One ${kind === 'lookup' ? 'transfer' : kind} can be at most 1,000,000.00.`,
      };
    case 'insufficient_funds':
      return {
        tone: 'danger',
        field: 'amount',
        title: 'Not enough cash you can use',
        detail: `This needs ${amount(body.required, 'USD')} and you can use ${amount(body.available, 'USD')}.${setAsideNote}`,
      };
    case 'unknown_recipient':
      return {
        tone: 'danger',
        field: 'recipient',
        title: 'Nobody has that handle',
        detail: 'Check the ten characters with the person you are sending to. No money moved.',
      };
    case 'self_transfer':
      return {
        tone: 'warning',
        field: 'recipient',
        title: 'That handle is your own',
        detail:
          'Sending to yourself would move nothing. Give your handle to someone else so they can send to you.',
      };
    case 'duplicate_movement':
      return {
        tone: 'info',
        field: 'form',
        title: 'That one was already received',
        detail: 'It was sent twice and counted once. No money moved a second time.',
      };
    case 'validation_failed':
      return validation(body, 'The request did not match what the server expects');
    case 'not_a_guest':
      return noSession;
    default:
      return serverFault('No money moved.');
  }
}

export function describeGuestError(error: unknown): Refusal {
  if (error instanceof NetworkError) return unreachable;
  if (error instanceof ApiError && error.status === 429) {
    const wait = error.body.retryAfterSeconds;
    return {
      tone: 'warning',
      field: 'form',
      title: 'Too many guest accounts from this address',
      detail: `Twenty can be created in an hour, and that limit is reached. You can keep watching the market${wait ? ` and try again in ${waitPhrase(wait)}` : ' and try again later'}.`,
      retryAfter: wait,
    };
  }
  return serverFault('No account was created.');
}
