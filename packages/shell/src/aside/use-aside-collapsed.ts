import { useCallback, useSyncExternalStore } from 'react';
import { ASIDE_WIDTH, asideCollapsesBelow } from '@dfai/ui';

/**
 * Whether the window is too narrow for the aside, by the one rule
 * (`collapseFor`, packages/ui/src/aside/collapse.ts) that shell.css draws as
 * media queries: the aside is folded by CSS, and this is how the app knows
 * it — the toggle's pressed state — without measuring anything. Asked of the
 * same `matchMedia` the stylesheet uses, so the two cannot disagree by a
 * pixel. `asideWidth` is the aside's width at hand: 340 while it shows the
 * type editor (`useAsideWidth`), which shell.css folds by its own pair.
 */
export function useAsideCollapsed({
  sidebarOpen,
  asideWidth = ASIDE_WIDTH,
}: {
  sidebarOpen: boolean;
  asideWidth?: number;
}): boolean {
  const query = `(max-width: ${asideCollapsesBelow({ sidebarOpen, asideWidth }) - 1}px)`;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = mediaOf(query);
      if (media === null) return () => {};
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => mediaOf(query)?.matches ?? false);
}

/** The window's answer to the query, or null where it has none (jsdom): such a window never folds. */
function mediaOf(query: string): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
}
