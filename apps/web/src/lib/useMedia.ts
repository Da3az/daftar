import { useSyncExternalStore } from 'react';

/** Match a media query. Used where a layout changes structure, not just size. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    () => window.matchMedia(query).matches,
  );
}

export const DESKTOP = '(min-width: 80rem)';
export const TABLET_UP = '(min-width: 48rem)';
