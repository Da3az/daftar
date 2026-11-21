import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './lib/prefs';
import './index.css';
import App from './App.tsx';
import type { ApiClient } from './api/client';
import { HttpApiClient } from './api/http';
import { usingMock } from './api/mode';

/**
 * The real API, always, in a production build. In development the mock can be
 * chosen instead (see api/mode.ts); the dynamic import sits behind
 * `import.meta.env.DEV` so the mock is not in the production bundle at all.
 */
async function chooseClient(): Promise<ApiClient> {
  if (import.meta.env.DEV && usingMock) {
    const { api } = await import('./mock');
    document.title = `[mock] ${document.title}`;
    return api;
  }
  return new HttpApiClient();
}

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');

void chooseClient().then((api) => {
  createRoot(root).render(
    <StrictMode>
      <App api={api} />
    </StrictMode>,
  );
});
