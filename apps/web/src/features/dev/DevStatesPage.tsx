import { useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, NetworkError } from '@/api/client';
import { useApi } from '@/api/context';
import type { ApiErrorBody, ExchangeOrder, Fill, LedgerEntry } from '@/api/types';
import { Button, Callout, Num } from '@/components/bits';
import { Panel, td, th } from '@/components/Panel';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/cn';
import { showCash } from '@/lib/money';
import {
  auditMock,
  DEV_SWITCH_DEFAULTS,
  devSwitches,
  enterAsSeededGuest,
  SEEDED_RECIPIENTS,
  seededDepositResult,
} from '@/mock';
import type { DevSwitchState } from '@/mock/devSwitches';
import {
  describeCancelError,
  describeCashError,
  describeGuestError,
  describeOrderError,
  type Refusal,
} from '../errors';
import { Ledger } from '../history/Ledger';
import { DeliveryLog } from '../portfolio/CashPanel';
import { confirmation } from '../trade/Ticket';

type Session = 'none' | 'seeded' | 'fresh' | 'keep';
interface Preset {
  label: string;
  how: string;
  to: string;
  session: Session;
  switches?: Partial<DevSwitchState>;
  /** Keep what is already on screen, so a failure shows over the last good data. */
  keepCache?: boolean;
}

const order = (code: DevSwitchState['forceOrderError'], label: string): Preset => ({
  label,
  how: 'Then send any order from the ticket.',
  to: '/',
  session: 'seeded',
  switches: { scenario: 'frozen', forceOrderError: code },
});
const cash = (code: DevSwitchState['forceCashError'], label: string, mode: string): Preset => ({
  label,
  how: `Then submit the ${mode} form.`,
  to: `/portfolio?cash=${mode}`,
  session: 'seeded',
  switches: { scenario: 'frozen', forceCashError: code },
});

const GROUPS: { title: string; presets: Preset[] }[] = [
  {
    title: 'Trade ( / )',
    presets: [
      {
        label: 'No session — first visit',
        how: 'Market data live; the ticket ends in "Enter as guest to trade".',
        to: '/',
        session: 'none',
      },
      {
        label: 'Loading — before any snapshot',
        how: 'Latency 1.5–3 s with an empty cache.',
        to: '/',
        session: 'none',
        switches: { latency: 'slow' },
      },
      {
        label: 'Market data error — last snapshot kept',
        how: 'Open Trade first so there is data, then use this. Panels are marked out of date and retry every second.',
        to: '/',
        session: 'keep',
        switches: { marketDown: true },
        keepCache: true,
      },
      {
        label: 'Market unavailable from first paint',
        how: 'Market calls fail with nothing cached.',
        to: '/',
        session: 'none',
        switches: { marketDown: true },
      },
      {
        label: 'Empty book',
        how: 'Both sides empty; bots stopped.',
        to: '/',
        session: 'none',
        switches: { scenario: 'empty' },
      },
      {
        label: 'Thin book — no asks',
        how: 'One side empty: no middle and no gap.',
        to: '/',
        session: 'none',
        switches: { scenario: 'thin' },
      },
      {
        label: 'Malformed fields',
        how: 'A few snapshot fields are broken; each shows "—" in its own cell.',
        to: '/',
        session: 'none',
        switches: { malformed: true },
      },
      {
        label: 'Guest with open, partly filled and filled orders',
        how: 'Seeded Guest 4817, bots stopped so the screen holds still.',
        to: '/',
        session: 'seeded',
        switches: { scenario: 'frozen' },
      },
      {
        label: 'Guest on a live market',
        how: 'Seeded guest with bots trading.',
        to: '/',
        session: 'seeded',
      },
      {
        label: 'Fresh guest — nothing yet',
        how: 'A new guest with 10,000.00 and no orders.',
        to: '/',
        session: 'fresh',
      },
      order('insufficient_funds', 'Order refused — insufficient funds'),
      order('invalid_quantity', 'Order refused — bad quantity'),
      order('invalid_price', 'Order refused — bad price'),
      order('too_many_open_orders', 'Order refused — 50 open orders'),
      order('no_liquidity', 'Order refused — no liquidity'),
      order('duplicate_order', 'Duplicate submit — same client id seen before'),
      order('request_in_progress', 'Duplicate submit — first copy still in flight'),
      order('idempotency_key_reused', 'Request id reused for a different order'),
      order('validation_failed', 'Order refused — schema validation'),
      order('rate_limited', 'Rate limited — 120 orders a minute'),
      order('internal_error', 'Server error on submit (500)'),
      order('not_a_guest', 'Session lost at submit'),
      {
        label: 'Cancel raced a fill',
        how: 'Then cancel any open order: it reports it was already done.',
        to: '/',
        session: 'seeded',
        switches: { scenario: 'frozen', forceCancelError: 'order_not_open' },
      },
      {
        label: 'Cancel — unknown order',
        how: 'Then cancel any open order.',
        to: '/',
        session: 'seeded',
        switches: { scenario: 'frozen', forceCancelError: 'unknown_order' },
      },
      {
        label: 'Guest creation rate limited',
        how: 'Then press "Enter as guest to trade".',
        to: '/',
        session: 'none',
        switches: { forceGuestError: 'rate_limited' },
      },
      {
        label: 'Session refresh failing',
        how: 'Balances and open orders keep their last values and are marked out of date.',
        to: '/',
        session: 'keep',
        switches: { sessionDown: true },
        keepCache: true,
      },
    ],
  },
  {
    title: 'Portfolio ( /portfolio )',
    presets: [
      {
        label: 'No session',
        how: 'Says what the page holds and lets the visitor enter as a guest right there.',
        to: '/portfolio',
        session: 'none',
      },
      {
        label: 'Loading',
        how: 'Slow latency with an empty cache.',
        to: '/portfolio',
        session: 'seeded',
        switches: { latency: 'slow', scenario: 'frozen' },
      },
      {
        label: 'First visit — everything empty',
        how: 'Fresh guest: no activity, sums show the opening 10,000.00.',
        to: '/portfolio',
        session: 'fresh',
      },
      {
        label: 'Populated',
        how: 'Seeded guest with every kind of movement.',
        to: '/portfolio',
        session: 'seeded',
        switches: { scenario: 'frozen' },
      },
      {
        label: 'Feed behind by N events',
        how: 'The publisher is stuck. Make a deposit or a trade and the waiting count grows.',
        to: '/portfolio',
        session: 'seeded',
        switches: { feedLag: 'stuck' },
      },
      {
        label: 'Deposit with 10 deliveries',
        how: 'Choose "10 at once" and deposit: the per-delivery log appears.',
        to: '/portfolio?cash=deposit',
        session: 'seeded',
        switches: { scenario: 'frozen' },
      },
      cash('amount_too_large', 'Deposit refused — over 10,000.00', 'deposit'),
      cash('deposit_limit', 'Deposit refused — ten in an hour', 'deposit'),
      cash('insufficient_funds', 'Withdrawal refused — not enough available cash', 'withdraw'),
      cash('duplicate_movement', 'Withdrawal — duplicate client id', 'withdraw'),
      cash('unknown_recipient', 'Send refused — unknown handle', 'send'),
      cash('self_transfer', 'Send refused — own handle', 'send'),
      cash('rate_limited', 'Rate limited — 30 withdrawals a minute', 'withdraw'),
      cash('internal_error', 'Server error on a cash movement', 'withdraw'),
    ],
  },
  {
    title: 'History ( /history )',
    presets: [
      {
        label: 'No session',
        how: 'Says what the page holds and lets the visitor enter as a guest right there.',
        to: '/history',
        session: 'none',
      },
      { label: 'Every table empty', how: 'Fresh guest.', to: '/history', session: 'fresh' },
      {
        label: 'Activity with every event type and delivery lag',
        how: 'Seeded guest.',
        to: '/history?tab=activity',
        session: 'seeded',
        switches: { scenario: 'frozen' },
      },
      {
        label: 'Trades — both sides, maker and taker',
        how: 'Seeded guest.',
        to: '/history?tab=trades',
        session: 'seeded',
        switches: { scenario: 'frozen' },
      },
      {
        label: 'Orders — every status and cancel reason',
        how: 'Seeded guest.',
        to: '/history?tab=orders',
        session: 'seeded',
        switches: { scenario: 'frozen' },
      },
      {
        label: 'History refresh failing',
        how: 'Tables keep their rows and are marked out of date.',
        to: '/history',
        session: 'keep',
        switches: { sessionDown: true },
        keepCache: true,
      },
    ],
  },
];

const err = (status: number, body: Partial<ApiErrorBody> & { error: string }): ApiError =>
  new ApiError(status, { message: body.error, ...body });
const sampleOrder = (patch: Partial<ExchangeOrder>): ExchangeOrder => ({
  clientOrderId: 'web-7c1e9a40-2f1b-4c8e-9d0a-51f7b2aa0c11',
  symbol: 'DFT',
  side: 'buy',
  type: 'limit',
  limitPrice: '25.05',
  quantity: '10.00000000',
  filledQuantity: '0.00000000',
  status: 'open',
  cancelReason: null,
  ...patch,
});
const fills: Fill[] = [
  { price: '25.04', quantity: '4.00000000', notional: '100.16' },
  { price: '25.05', quantity: '2.00000000', notional: '50.10' },
];
const CONFIRMATIONS = [
  [
    'Accepted — filled in full',
    confirmation({
      order: sampleOrder({
        status: 'filled',
        quantity: '6.00000000',
        filledQuantity: '6.00000000',
      }),
      fills,
      replayed: false,
    }),
  ],
  [
    'Accepted — partly filled, the rest waiting',
    confirmation({ order: sampleOrder({ filledQuantity: '6.00000000' }), fills, replayed: false }),
  ],
  [
    'Accepted — partly filled, the rest cancelled (market order)',
    confirmation({
      order: sampleOrder({
        type: 'market',
        limitPrice: null,
        status: 'cancelled',
        cancelReason: 'no_liquidity',
        filledQuantity: '6.00000000',
      }),
      fills,
      replayed: false,
    }),
  ],
  [
    'Accepted — waiting untouched',
    confirmation({ order: sampleOrder({}), fills: [], replayed: false }),
  ],
  [
    'Duplicate submit — replayed, one order',
    confirmation({ order: sampleOrder({}), fills: [], replayed: true }),
  ],
] as const;

const REFUSALS: [string, Refusal][] = [
  [
    'insufficient_funds (USD)',
    describeOrderError(
      err(422, {
        error: 'insufficient_funds',
        unit: 'USD',
        available: '180.00',
        required: '250.10',
      }),
      ' Another 9,647.04 USD is set aside for open orders.',
    ),
  ],
  [
    'insufficient_funds (DFT)',
    describeOrderError(
      err(422, {
        error: 'insufficient_funds',
        unit: 'DFT',
        available: '5.00000000',
        required: '12.00000000',
      }),
    ),
  ],
  ['invalid_quantity', describeOrderError(err(422, { error: 'invalid_quantity' }))],
  ['invalid_price', describeOrderError(err(422, { error: 'invalid_price' }))],
  ['too_many_open_orders', describeOrderError(err(422, { error: 'too_many_open_orders' }))],
  ['no_liquidity', describeOrderError(err(422, { error: 'no_liquidity' }))],
  ['duplicate_order', describeOrderError(err(409, { error: 'duplicate_order' }))],
  ['request_in_progress', describeOrderError(err(409, { error: 'request_in_progress' }))],
  ['idempotency_key_reused', describeOrderError(err(422, { error: 'idempotency_key_reused' }))],
  [
    'validation_failed',
    describeOrderError(
      err(400, {
        error: 'validation_failed',
        issues: [{ path: 'limitPrice', message: 'not allowed on a market order' }],
      }),
    ),
  ],
  ['429 on orders', describeOrderError(err(429, { error: 'rate_limited', retryAfterSeconds: 14 }))],
  ['500 internal_error', describeOrderError(err(500, { error: 'internal_error' }))],
  ['network failure', describeOrderError(new NetworkError())],
  ['cancel: order_not_open', describeCancelError(err(409, { error: 'order_not_open' }))],
  ['cancel: unknown_order', describeCancelError(err(404, { error: 'unknown_order' }))],
  ['guest: 429', describeGuestError(err(429, { error: 'rate_limited', retryAfterSeconds: 1800 }))],
  [
    'deposit: amount_too_large',
    describeCashError(err(422, { error: 'amount_too_large' }), 'deposit'),
  ],
  ['deposit: deposit_limit', describeCashError(err(429, { error: 'deposit_limit' }), 'deposit')],
  [
    'withdrawal: insufficient_funds',
    describeCashError(
      err(422, {
        error: 'insufficient_funds',
        unit: 'USD',
        available: '1283.58',
        required: '5000.00',
      }),
      'withdrawal',
      ' Another 9,647.04 USD is set aside for open buy orders and cannot leave until they fill or are cancelled.',
    ),
  ],
  [
    'transfer: unknown_recipient',
    describeCashError(err(404, { error: 'unknown_recipient' }), 'transfer'),
  ],
  ['transfer: self_transfer', describeCashError(err(422, { error: 'self_transfer' }), 'transfer')],
  [
    'movement: duplicate_movement',
    describeCashError(err(409, { error: 'duplicate_movement' }), 'withdrawal'),
  ],
  [
    'movement: 429',
    describeCashError(err(429, { error: 'rate_limited', retryAfterSeconds: 9 }), 'transfer'),
  ],
];

const LEDGER: LedgerEntry[] = [
  { account: 'Your cash', direction: 'debit', amount: '100.12', unit: 'USD' },
  { account: 'Kestrel · cash', direction: 'credit', amount: '100.12', unit: 'USD' },
  { account: 'Kestrel · DFT', direction: 'debit', amount: '4.00000000', unit: 'DFT' },
  { account: 'Your DFT', direction: 'credit', amount: '4.00000000', unit: 'DFT' },
];

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-6 text-sm">
      {label}
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}

/** Dev only. Every screen in every state: set one up and open it, or see the outcome rendered below. */
export function DevStatesPage() {
  const api = useApi();
  const client = useQueryClient();
  const navigate = useNavigate();
  const switches = useSyncExternalStore(devSwitches.subscribe, devSwitches.get);
  const set = (patch: Partial<DevSwitchState>) => {
    devSwitches.set(patch);
    void client.invalidateQueries();
  };
  const apply = async (preset: Preset) => {
    const target = { ...DEV_SWITCH_DEFAULTS, ...preset.switches };
    devSwitches.set({ ...DEV_SWITCH_DEFAULTS, scenario: target.scenario });
    if (preset.session === 'none' || preset.session === 'fresh')
      await api.logout().catch(() => undefined);
    if (preset.session === 'fresh') await api.enterAsGuest().catch(() => undefined);
    if (preset.session === 'seeded') enterAsSeededGuest();
    devSwitches.set(target);
    if (preset.keepCache) void client.invalidateQueries();
    else client.clear();
    void navigate(preset.to);
  };
  const audit = auditMock();
  const deposit = seededDepositResult();
  const choice = <K extends keyof DevSwitchState>(key: K, values: (DevSwitchState[K] | null)[]) => (
    <label className="flex items-center justify-between gap-6 text-sm">
      {key}
      <Select
        label={key}
        value={String(switches[key])}
        onChange={(value) => set({ [key]: value === 'null' ? null : value })}
        options={values.map((value) => ({
          value: String(value),
          label: value === null ? 'off' : String(value),
        }))}
        className="h-12 min-w-90 text-sm"
      />
    </label>
  );

  return (
    <div className="mx-auto flex max-w-720 flex-col gap-7 px-4 py-5 md:px-10 md:py-7">
      <Panel
        title="Dev: every screen in every state"
        aside={
          <span className="text-sm text-ink-3">
            not part of the product — remove before release
          </span>
        }
      >
        <div className="grid gap-x-12 gap-y-3 px-7 pb-7 md:grid-cols-2 xl:grid-cols-3">
          {choice('scenario', ['live', 'frozen', 'thin', 'empty'])}
          {choice('latency', ['normal', 'slow', 'none'])}
          {choice('feedLag', ['normal', 'stuck'])}
          {choice('forceOrderError', [
            null,
            'insufficient_funds',
            'invalid_quantity',
            'invalid_price',
            'too_many_open_orders',
            'no_liquidity',
            'duplicate_order',
            'request_in_progress',
            'idempotency_key_reused',
            'validation_failed',
            'rate_limited',
            'internal_error',
            'not_a_guest',
          ])}
          {choice('forceCancelError', [null, 'order_not_open', 'unknown_order', 'rate_limited'])}
          {choice('forceCashError', [
            null,
            'amount_too_large',
            'deposit_limit',
            'insufficient_funds',
            'unknown_recipient',
            'self_transfer',
            'duplicate_movement',
            'rate_limited',
            'internal_error',
          ])}
          {choice('forceGuestError', [null, 'rate_limited'])}
          <Toggle
            label="marketDown"
            checked={switches.marketDown}
            onChange={(marketDown) => set({ marketDown })}
          />
          <Toggle
            label="sessionDown"
            checked={switches.sessionDown}
            onChange={(sessionDown) => set({ sessionDown })}
          />
          <Toggle
            label="malformed"
            checked={switches.malformed}
            onChange={(malformed) => set({ malformed })}
          />
          <div className="flex flex-wrap items-center gap-4 md:col-span-2 xl:col-span-3">
            <Button
              size="sm"
              onClick={() => {
                devSwitches.reset();
                void client.invalidateQueries();
              }}
            >
              All switches off
            </Button>
            <Button
              size="sm"
              onClick={() => {
                enterAsSeededGuest();
                client.clear();
              }}
            >
              Become seeded Guest 4817
            </Button>
            <span className={cn('text-sm', audit.ok ? 'text-success' : 'text-danger')}>
              Ledger audit:{' '}
              {audit.ok
                ? 'balanced — cash and coin conserved, reservations match open orders'
                : audit.problems.join('; ')}
            </span>
          </div>
          <p className="text-sm text-ink-3 md:col-span-2 xl:col-span-3">
            Switches hold until the page is reloaded. Seeded recipients for the send form:{' '}
            {SEEDED_RECIPIENTS.map((r) => (
              <span key={r.handle} className="mr-5 whitespace-nowrap">
                <Num className="text-ink">{r.handle}</Num> {r.displayName.slice(0, 22)}
              </span>
            ))}
          </p>
        </div>
      </Panel>

      {GROUPS.map((group) => (
        <Panel key={group.title} title={group.title}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>State</th>
                <th className={cn(th, 'hidden md:table-cell')}>How it is produced</th>
                <th className={th}>
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {group.presets.map((preset) => (
                <tr key={preset.label} className="border-b border-line">
                  <td className={cn(td, 'whitespace-normal py-2 font-medium')}>{preset.label}</td>
                  <td className={cn(td, 'hidden whitespace-normal py-2 text-ink-2 md:table-cell')}>
                    {preset.how}
                  </td>
                  <td className={cn(td, 'py-2 text-right')}>
                    <Button size="sm" variant="brand" onClick={() => void apply(preset)}>
                      Set up and open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ))}

      <Panel
        title="Order confirmations"
        aside={
          <span className="text-sm text-ink-3">as shown under the ticket and in the toast</span>
        }
      >
        <div className="grid gap-5 px-7 pb-7 md:grid-cols-2">
          {CONFIRMATIONS.map(
            ([label, outcome]) =>
              outcome.kind === 'done' && (
                <figure key={label}>
                  <figcaption className="mb-1 text-xs text-ink-3">{label}</figcaption>
                  <Callout tone={outcome.tone} title={outcome.title}>
                    {outcome.detail}
                  </Callout>
                </figure>
              ),
          )}
        </div>
      </Panel>

      <Panel
        title="Refusals, in place"
        aside={
          <span className="text-sm text-ink-3">
            one per code; shown next to the control that caused it
          </span>
        }
      >
        <div className="grid gap-5 px-7 pb-7 md:grid-cols-2 xl:grid-cols-3">
          {REFUSALS.map(([label, refusal]) => (
            <figure key={label}>
              <figcaption className="num mb-1 text-xs text-ink-3">
                {label} → next to: {refusal.field}
              </figcaption>
              <Callout tone={refusal.tone} title={refusal.title}>
                {refusal.detail}
              </Callout>
            </figure>
          ))}
        </div>
      </Panel>

      <div className="grid items-start gap-7 xl:grid-cols-2">
        <Panel
          title="Deposit delivered 10 times"
          aside={
            <span className="text-sm text-ink-3">
              seeded: 1 processed, 8 duplicates, 1 told to retry
            </span>
          }
        >
          <div className="px-7 pb-7">
            {deposit ? (
              <DeliveryLog result={deposit} />
            ) : (
              <p className="text-sm text-ink-3">Become the seeded guest to load its deposit log.</p>
            )}
          </div>
        </Panel>
        <Panel
          title="Ledger lines for one fill"
          aside={<span className="text-sm text-ink-3">bought 4.00 DFT at 25.03 from Kestrel</span>}
        >
          <div className="px-7 pb-7">
            <Ledger entries={LEDGER} />
            <p className="mt-5 text-sm text-ink-3">
              Large figures stay on one line and truncate with the full value on hover:{' '}
              <Num className="text-ink">{showCash('98765432109876.54')}</Num>
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
