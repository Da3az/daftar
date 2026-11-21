import type { Me } from '@/api/types';
import { LinkButton, Num } from '@/components/bits';
import { Panel } from '@/components/Panel';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  formatCash,
  formatQty,
  notional,
  parseCash,
  parseQty,
  ratioForBar,
  showCash,
  showQty,
} from '@/lib/money';
import { QUOTE, SYMBOL } from '@/lib/rules';
import { showTime } from '@/lib/time';

export interface Holdings {
  cash: bigint;
  cashFree: bigint;
  cashAside: bigint;
  coin: bigint;
  coinFree: bigint;
  coinAside: bigint;
  coinValue: bigint;
  equity: bigint;
}

export function holdingsOf(me: Me, lastPrice: string | undefined): Holdings | null {
  const cash = parseCash(me.balances.cash);
  const cashFree = parseCash(me.balances.cashAvailable);
  const coin = parseQty(me.balances.asset);
  const coinFree = parseQty(me.balances.assetAvailable);
  const price = parseCash(lastPrice);
  if (cash === null || cashFree === null || coin === null || coinFree === null || price === null)
    return null;
  const coinValue = notional(price, coin);
  return {
    cash,
    cashFree,
    cashAside: cash - cashFree,
    coin,
    coinFree,
    coinAside: coin - coinFree,
    coinValue,
    equity: cash + coinValue,
  };
}

/** Which open orders hold what. The parts are listed and add up to the figure that opened this. */
export function SetAsideList({ me, unit }: { me: Me; unit: 'USD' | 'DFT' }) {
  const side = unit === 'USD' ? 'buy' : 'sell';
  const rows = me.openOrders
    .filter((order) => order.side === side && order.status === 'open' && order.limitPrice)
    .map((order) => {
      const left = (parseQty(order.quantity) ?? 0n) - (parseQty(order.filledQuantity) ?? 0n);
      const held = unit === 'USD' ? notional(parseCash(order.limitPrice) ?? 0n, left) : left;
      return { order, left, held };
    });
  const total = rows.reduce((sum, row) => sum + row.held, 0n);
  const show = (value: bigint) =>
    unit === 'USD' ? showCash(formatCash(value)) : showQty(formatQty(value));
  return (
    <div>
      <h3 className="font-display text-lg font-semibold">
        Set aside for {rows.length} {side} {rows.length === 1 ? 'order' : 'orders'}
      </h3>
      <p className="mt-1 text-ink-2">
        {unit === 'USD'
          ? 'An order waiting to buy keeps its cash ready. That cash cannot be withdrawn or spent twice.'
          : 'An order waiting to sell keeps its coins ready. Those coins cannot be sold twice.'}{' '}
        Cancel an order to free its share.
      </p>
      <table className="mt-4 w-full border-collapse text-sm">
        <tbody>
          {rows.map(({ order, left, held }) => (
            <tr key={order.clientOrderId} className="border-t border-line">
              <td className="py-2">
                {side === 'buy' ? 'Buy' : 'Sell'} <Num>{showQty(formatQty(left))}</Num> at{' '}
                <Num>{showCash(order.limitPrice)}</Num>
              </td>
              <td className="num py-2 text-right">{show(held)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-ink font-semibold">
            <td className="py-2">Set aside in total</td>
            <td className="num py-2 text-right">
              {show(total)} {unit}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Row({
  swatch,
  label,
  value,
  strong,
}: {
  swatch?: string;
  label: React.ReactNode;
  value: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div
      className={
        strong
          ? 'mt-2 flex items-baseline gap-4 border-t-2 border-ink pt-3 font-semibold'
          : 'flex items-baseline gap-4 py-1'
      }
    >
      <span
        aria-hidden
        className={`size-5 flex-none self-center rounded-bar border border-ink/40 ${swatch ?? 'invisible'}`}
      />
      <span className="min-w-0 flex-1 text-sm">{label}</span>
      <span className="num whitespace-nowrap text-md">{value}</span>
    </div>
  );
}

/** One bar that adds up: cash you can use + cash set aside + coins at the last price = worth in total. */
export function YourMoney({
  me,
  lastPrice,
  asOf,
  staleSince,
  className,
}: {
  me: Me;
  lastPrice: string | undefined;
  asOf: number;
  staleSince: number | null;
  className?: string;
}) {
  const h = holdingsOf(me, lastPrice);
  const asideOrders = (unit: 'USD' | 'DFT', count: number) => (
    <Popover>
      <PopoverTrigger asChild>
        <LinkButton>
          {count} {unit === 'USD' ? 'buy' : 'sell'} {count === 1 ? 'order' : 'orders'}
        </LinkButton>
      </PopoverTrigger>
      <PopoverContent>
        <SetAsideList me={me} unit={unit} />
      </PopoverContent>
    </Popover>
  );
  const buys = me.openOrders.filter(
    (order) => order.side === 'buy' && order.status === 'open',
  ).length;
  const sells = me.openOrders.filter(
    (order) => order.side === 'sell' && order.status === 'open',
  ).length;
  return (
    <Panel
      title="Your money"
      actions={
        <span className="text-sm text-ink-3">
          as of <Num>{showTime(asOf)}</Num> UTC
        </span>
      }
      staleSince={staleSince}
      className={className}
    >
      <div className="px-7 pb-6">
        {h ? (
          <>
            <div
              className="mb-3 flex h-7 overflow-hidden rounded-tag border border-ink/40"
              role="img"
              aria-label="Share of your total: cash you can use, cash set aside, coins"
            >
              <span
                className="bg-brand"
                style={{ width: `${ratioForBar(h.cashFree, h.equity) * 100}%` }}
              />
              <span
                className="bg-notice"
                style={{ width: `${ratioForBar(h.cashAside, h.equity) * 100}%` }}
              />
              <span
                className="bg-you"
                style={{ width: `${ratioForBar(h.coinValue, h.equity) * 100}%` }}
              />
            </div>
            <Row swatch="bg-brand" label="Cash you can use" value={showCash(h.cashFree)} />
            <Row
              swatch="bg-notice"
              label={
                h.cashAside > 0n ? (
                  <>Cash set aside for {asideOrders('USD', buys)}</>
                ) : (
                  'Cash set aside for orders'
                )
              }
              value={showCash(h.cashAside)}
            />
            <Row
              swatch="bg-you"
              label={
                <>
                  <Num>{showQty(h.coin)}</Num> {SYMBOL} at <Num>{showCash(lastPrice)}</Num>
                  {h.coinAside > 0n ? (
                    <>
                      {' '}
                      · <Num>{showQty(h.coinFree)}</Num> free, rest in {asideOrders('DFT', sells)}
                    </>
                  ) : null}
                </>
              }
              value={showCash(h.coinValue)}
            />
            <Row
              strong
              label="Worth in total"
              value={
                <>
                  {showCash(h.equity)} <span className="font-ui text-sm font-medium">{QUOTE}</span>
                </>
              }
            />
          </>
        ) : (
          <p className="text-sm text-ink-3">
            Balances are not readable right now (—). They will appear on the next refresh.
          </p>
        )}
      </div>
    </Panel>
  );
}
