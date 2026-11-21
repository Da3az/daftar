const KEY = 'daftar.dev.mock';

/**
 * Development only: which back end this tab talks to.
 *
 * Default is the real API through the Vite proxy. `?mock` (or `VITE_USE_MOCK=1`)
 * switches to the in-browser mock, and opening `/dev/states` does too, since
 * every state on that page is staged on the mock. The choice is kept for the
 * tab in sessionStorage so a reload stays where it was; `?mock=0` goes back.
 *
 * In a production build `import.meta.env.DEV` is false and this is never true.
 */
function decide(): boolean {
  if (!import.meta.env.DEV) return false;
  const param = new URLSearchParams(window.location.search).get('mock');
  if (param !== null) {
    const on = param !== '0';
    if (on) sessionStorage.setItem(KEY, '1');
    else sessionStorage.removeItem(KEY);
    return on;
  }
  if (window.location.pathname.startsWith('/dev/')) {
    sessionStorage.setItem(KEY, '1');
    return true;
  }
  return import.meta.env.VITE_USE_MOCK === '1' || sessionStorage.getItem(KEY) === '1';
}

export const usingMock: boolean = decide();
