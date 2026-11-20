import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Which account the interface is looking at.
 *
 * There is no authentication in this project and the README says so. That is a
 * deliberate scope decision, not an oversight: the thing being demonstrated is
 * a correct ledger under concurrency, and bolting on a login would add a
 * password-hashing capacity constraint and a session store without making the
 * ledger any more or less correct.
 *
 * So "the current account" is a client-side selection, held here. It is a view
 * preference, exactly like a chosen date range — the server authorises nothing
 * on it, and every endpoint it feeds is a read of seeded demo data.
 *
 * **If this ever gained real users, this store would be the thing to delete,**
 * not to secure. The account would come from a session the server established.
 */
interface AccountState {
  externalId: string;
  setExternalId: (externalId: string) => void;
}

/** The first seeded customer. A sensible landing state rather than an empty one. */
export const DEFAULT_ACCOUNT = 'seed-000001';

export const useAccountStore = create<AccountState>()(
  persist(
    (set) => ({
      externalId: DEFAULT_ACCOUNT,
      setExternalId: (externalId) => set({ externalId }),
    }),
    { name: 'daftar.account' },
  ),
);

/**
 * Selector hooks, so components subscribe to one field rather than the store.
 *
 * Reading the whole store re-renders every consumer on any change — and with an
 * object or array selector it re-renders on every *render*, because a fresh
 * object is never referentially equal. These return primitives, so no
 * `useShallow` is needed; anything returning an object here would need it.
 */
export const useCurrentAccount = (): string => useAccountStore((state) => state.externalId);
export const useSetAccount = (): ((externalId: string) => void) =>
  useAccountStore((state) => state.setExternalId);
