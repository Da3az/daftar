export type Scenario = 'live' | 'thin' | 'empty' | 'frozen';

export type ForcedOrderError =
  | 'validation_failed'
  | 'duplicate_order'
  | 'request_in_progress'
  | 'idempotency_key_reused'
  | 'invalid_quantity'
  | 'invalid_price'
  | 'insufficient_funds'
  | 'too_many_open_orders'
  | 'no_liquidity'
  | 'rate_limited'
  | 'internal_error'
  | 'not_a_guest';
export type ForcedCancelError = 'unknown_order' | 'order_not_open' | 'rate_limited';
export type ForcedCashError =
  | 'amount_too_large'
  | 'deposit_limit'
  | 'insufficient_funds'
  | 'unknown_recipient'
  | 'self_transfer'
  | 'duplicate_movement'
  | 'rate_limited'
  | 'internal_error';
export type ForcedGuestError = 'rate_limited';

export interface DevSwitchState {
  /** Changing it rebuilds the mock (resetMock). */
  scenario: Scenario;
  forceOrderError: ForcedOrderError | null;
  forceCancelError: ForcedCancelError | null;
  forceCashError: ForcedCashError | null;
  forceGuestError: ForcedGuestError | null;
  /** getMarket / getCandles throw NetworkError. */
  marketDown: boolean;
  /** getMe / listOrders / listFills / getActivity answer 500 internal_error. */
  sessionDown: boolean;
  /** normal 40–160 ms, slow 1.5–3 s, none 0. */
  latency: 'normal' | 'slow' | 'none';
  /** stuck: the activity worker publishes nothing, so pending grows. */
  feedLag: 'normal' | 'stuck';
  /** getMarket returns a snapshot with a few deliberately broken fields. */
  malformed: boolean;
}

export const DEV_SWITCH_DEFAULTS: Readonly<DevSwitchState> = Object.freeze({
  scenario: 'live',
  forceOrderError: null,
  forceCancelError: null,
  forceCashError: null,
  forceGuestError: null,
  marketDown: false,
  sessionDown: false,
  latency: 'normal',
  feedLag: 'normal',
  malformed: false,
});

let state: Readonly<DevSwitchState> = DEV_SWITCH_DEFAULTS;
const listeners = new Set<() => void>();

/** Stable between changes, so it can be handed straight to useSyncExternalStore. */
function get(): Readonly<DevSwitchState> {
  return state;
}

function set(patch: Partial<DevSwitchState>): void {
  const next = { ...state, ...patch };
  const changed = (Object.keys(next) as (keyof DevSwitchState)[]).some(
    (key) => next[key] !== state[key],
  );
  if (!changed) return;
  state = Object.freeze(next);
  for (const listener of [...listeners]) listener();
}

function reset(): void {
  set(DEV_SWITCH_DEFAULTS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const devSwitches = { get, set, reset, subscribe };
