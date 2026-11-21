import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { OrderType, Side } from '@/api/types';
import type { TicketValues } from './ticketMath';

interface TicketStore {
  values: TicketValues;
  set: (patch: Partial<TicketValues>) => void;
  /** From a click on a book price: switch to a limit order at that price and point at the field. */
  takePrice: (price: string) => void;
  /** Bumps when a price is taken from the book, so the field can flash. */
  priceTaken: number;
  focusRef: React.RefObject<HTMLInputElement | null>;
  setSide: (side: Side) => void;
  setType: (type: OrderType) => void;
}

const Context = createContext<TicketStore | null>(null);

export function TicketProvider({ children }: { children: ReactNode }) {
  const [values, setValues] = useState<TicketValues>({
    side: 'buy',
    type: 'limit',
    price: '',
    quantity: '',
  });
  const [priceTaken, setPriceTaken] = useState(0);
  const focusRef = useRef<HTMLInputElement | null>(null);
  const set = useCallback(
    (patch: Partial<TicketValues>) => setValues((current) => ({ ...current, ...patch })),
    [],
  );
  const takePrice = useCallback((price: string) => {
    setValues((current) => ({ ...current, type: 'limit', price }));
    setPriceTaken((n) => n + 1);
  }, []);
  const store = useMemo<TicketStore>(
    () => ({
      values,
      set,
      takePrice,
      priceTaken,
      focusRef,
      setSide: (side) => set({ side }),
      setType: (type) => set({ type }),
    }),
    [values, set, takePrice, priceTaken],
  );
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export function useTicket(): TicketStore {
  const store = useContext(Context);
  if (!store) throw new Error('useTicket must be used inside a TicketProvider');
  return store;
}
