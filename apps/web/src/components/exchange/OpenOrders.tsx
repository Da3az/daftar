import { useMutation } from '@tanstack/react-query';
import { formatCash } from '@/lib/money';
import { cancelOrder, trimQuantity, useRefreshExchange, type ExchangeOrder } from '@/lib/exchange';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  Table,
  Td,
  TdNum,
  Th,
  ThNum,
} from '@/components/ui/primitives';

/** The guest's resting orders, each with a cancel button. */
export function OpenOrders({ orders }: { orders: ExchangeOrder[] }): React.JSX.Element {
  const refresh = useRefreshExchange();

  const cancel = useMutation({
    mutationFn: cancelOrder,
    // Refreshed on failure too: a 409 here means the order filled or was
    // already cancelled, and the list on screen is what is out of date.
    onSettled: refresh,
  });

  return (
    <Card>
      <CardHeader
        title="Your open orders"
        hint="Resting on the book. Cash and coins they need are reserved until they fill or you cancel."
      />
      {orders.length === 0 ? (
        <Empty>Nothing resting. A limit order away from the market will appear here.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Side</Th>
              <ThNum>Price</ThNum>
              <ThNum>Quantity</ThNum>
              <ThNum>Filled</ThNum>
              <Th />
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.clientOrderId}>
                <Td>
                  <Badge tone={order.side === 'buy' ? 'credit' : 'debit'}>{order.side}</Badge>
                </Td>
                <TdNum>{order.limitPrice === null ? '—' : formatCash(order.limitPrice)}</TdNum>
                <TdNum>{trimQuantity(order.quantity)}</TdNum>
                <TdNum>{trimQuantity(order.filledQuantity)}</TdNum>
                <Td className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={cancel.isPending && cancel.variables === order.clientOrderId}
                    onClick={() => cancel.mutate(order.clientOrderId)}
                  >
                    Cancel
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
