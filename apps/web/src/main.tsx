import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import './styles.css';

/**
 * Query defaults, chosen against what this data actually is.
 *
 * A ledger is append-only, so a transaction list does not change under the
 * reader except by growing. Aggressive refetching would be pure cost.
 *
 * `retry: 1`, not the default 3. A failed read here is almost always the API
 * being down or a 404 on an account id someone typed, and neither improves on
 * the third attempt — it just delays the error message by several seconds.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      // Never. A retried order is a second order unless it carries an
      // Idempotency-Key, and deciding that for every mutation from one global
      // default is exactly how a customer gets charged twice.
      retry: 0,
    },
  },
});

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  // Scroll restoration on a ledger list matters: paging back should return to
  // where the reader was, not to the top.
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
