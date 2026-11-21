import { useMemo, useSyncExternalStore } from 'react';
import { formatRoute, parseRoute, type Route } from './route.ts';

/** Fired when the route changes without a `hashchange` (a replaced history entry). */
const REPLACED = 'lite:route-replaced';

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  window.addEventListener(REPLACED, listener);
  return () => {
    window.removeEventListener('hashchange', listener);
    window.removeEventListener(REPLACED, listener);
  };
}

const currentHash = (): string => window.location.hash;

/**
 * The route the hash names now, re-read on back, forward and every navigation.
 * The same object until the hash changes, so effects that depend on it run once per move.
 */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, currentHash);
  return useMemo(() => parseRoute(hash), [hash]);
}

/**
 * Goes to `route`. `replace` swaps the history entry instead of adding one:
 * for redirects (`#/new` becoming the note it made) that back should skip.
 */
export function navigate(route: Route, { replace = false }: { replace?: boolean } = {}): void {
  const hash = formatRoute(route);
  if (!replace) {
    if (window.location.hash !== hash) window.location.hash = hash;
    return;
  }
  const url = `${window.location.pathname}${hash}`;
  window.history.replaceState(window.history.state, '', url);
  window.dispatchEvent(new Event(REPLACED));
}
