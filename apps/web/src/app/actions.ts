/* Cross-cutting actions the palette and the keyboard both trigger. Components listen for the events they own. */
export type AppEvent = 'daftar:interval' | 'daftar:palette' | 'daftar:keys';

export function emit<T>(name: AppEvent, detail?: T): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function listen<T>(name: AppEvent, handler: (detail: T) => void): () => void {
  const wrapped = (event: Event) => handler((event as CustomEvent<T>).detail);
  window.addEventListener(name, wrapped);
  return () => window.removeEventListener(name, wrapped);
}

export function submitTicket(): void {
  const form = document.getElementById('ticket-form');
  if (form instanceof HTMLFormElement) form.requestSubmit();
}

export const SHORTCUTS: { keys: string; does: string; group: 'Anywhere' | 'Trade' }[] = [
  { keys: 'Ctrl K', does: 'Search actions', group: 'Anywhere' },
  { keys: '?', does: 'Show this list', group: 'Anywhere' },
  { keys: 'G then T', does: 'Go to Trade', group: 'Anywhere' },
  { keys: 'G then P', does: 'Go to Portfolio', group: 'Anywhere' },
  { keys: 'G then H', does: 'Go to History', group: 'Anywhere' },
  { keys: 'B / S', does: 'Buy or sell side', group: 'Trade' },
  { keys: 'L / M', does: 'Limit or market order', group: 'Trade' },
  { keys: '/', does: 'Jump to the price field', group: 'Trade' },
  { keys: '1 / 2 / 3', does: 'Chart interval: 1 min, 5 min, 1 hour', group: 'Trade' },
  { keys: 'Ctrl Enter', does: 'Send the order', group: 'Trade' },
];
