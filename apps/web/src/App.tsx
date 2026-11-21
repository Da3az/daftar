import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import type { ApiClient } from '@/api/client';
import { ApiProvider } from '@/api/context';
import { usingMock } from '@/api/mode';
import { Shell } from '@/app/Shell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { HistoryPage } from '@/features/history/HistoryPage';
import { PortfolioPage } from '@/features/portfolio/PortfolioPage';
import { TradePage } from '@/features/trade/TradePage';
import { TicketProvider } from '@/features/trade/ticketStore';

/**
 * /dev/states exists only in development, and only on the mock: every state it
 * stages is a mock switch. `import.meta.env.DEV` is a build-time constant, so a
 * production bundle contains neither the route nor the page.
 */
const DevStatesPage = import.meta.env.DEV
  ? lazy(() => import('@/features/dev/DevStatesPage').then((m) => ({ default: m.DevStatesPage })))
  : null;

function DevStatesRoute() {
  if (DevStatesPage === null) return null;
  if (!usingMock) {
    return (
      <p className="p-10 text-ink-2">
        These states are staged on the in-browser mock.{' '}
        <a className="text-info underline" href="/dev/states?mock">
          Reload on the mock
        </a>
        .
      </p>
    );
  }
  return (
    <Suspense fallback={null}>
      <DevStatesPage />
    </Suspense>
  );
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

export default function App({ api }: { api: ApiClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider client={api}>
        <TooltipProvider delayDuration={300}>
          <TicketProvider>
            <BrowserRouter>
              <Routes>
                <Route element={<Shell />}>
                  <Route index element={<TradePage />} />
                  <Route path="portfolio" element={<PortfolioPage />} />
                  <Route path="history" element={<HistoryPage />} />
                  {import.meta.env.DEV && <Route path="dev/states" element={<DevStatesRoute />} />}
                  <Route
                    path="*"
                    element={<p className="p-10 text-ink-2">There is no page at this address.</p>}
                  />
                </Route>
              </Routes>
            </BrowserRouter>
          </TicketProvider>
        </TooltipProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}
