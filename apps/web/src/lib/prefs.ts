import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export type SchemePref = 'green-up' | 'red-up' | 'blue-orange';
export interface Prefs {
  theme: ThemePref;
  scheme: SchemePref;
  /** Flash a changed book quantity and a new trade row. */
  flash: boolean;
  /** Single-key shortcuts. Ctrl/Cmd combinations always work. */
  shortcuts: boolean;
}

const KEY = 'daftar.prefs';
const DEFAULTS: Prefs = { theme: 'system', scheme: 'green-up', flash: true, shortcuts: true };
const listeners = new Set<() => void>();
const dark = window.matchMedia('(prefers-color-scheme: dark)');

function load(): Prefs {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { ...DEFAULTS, ...(typeof stored === 'object' && stored !== null ? stored : {}) };
  } catch {
    return DEFAULTS;
  }
}

let current = load();

export function resolvedTheme(prefs: Prefs = current): 'light' | 'dark' {
  return prefs.theme === 'system' ? (dark.matches ? 'dark' : 'light') : prefs.theme;
}

function apply(): void {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme();
  if (current.scheme === 'green-up') delete root.dataset.scheme;
  else root.dataset.scheme = current.scheme;
  if (current.flash) delete root.dataset.flash;
  else root.dataset.flash = 'off';
}

export function setPrefs(patch: Partial<Prefs>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage may be unavailable; the preference still holds for this page */
  }
  apply();
  listeners.forEach((listener) => listener());
}

dark.addEventListener('change', () => {
  apply();
  listeners.forEach((listener) => listener());
});
apply();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const usePrefs = (): Prefs => useSyncExternalStore(subscribe, () => current);
