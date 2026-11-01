import { createStore, useStore, type StoreApi } from 'zustand';
import type { LinkFragment, TabId, VaultPath } from '@dfai/domain';
import type { NoteReveal } from '@dfai/ui';

/** A block or heading asked to be brought into view in a tab, and the note it is in. */
interface TabReveal {
  readonly path: VaultPath;
  readonly reveal: NoteReveal;
}

interface RevealState {
  readonly byTab: ReadonlyMap<TabId, TabReveal>;
  /** How many requests have been made: each one's key, so following the same link twice scrolls twice. */
  readonly asked: number;
}

/**
 * Where each tab was asked to scroll to (P26-03): a followed `[[Note#^id]]`
 * or a shown block's source opens the note at that block. Held outside the
 * components (ADR-0040), keyed by tab, so a request draws the tab it is for
 * and nothing else. The request is kept for the note it was made for, so a
 * tab that has since moved on to another note is not scrolled, and is spent
 * once shown.
 */
export type RevealStore = StoreApi<RevealState>;

export function createRevealStore(): RevealStore {
  return createStore<RevealState>()(() => ({ byTab: new Map(), asked: 0 }));
}

export function requestReveal(
  store: RevealStore,
  { tab, path, fragment }: { tab: TabId; path: VaultPath; fragment: LinkFragment },
): void {
  const key = store.getState().asked + 1;
  // Spent once shown, so the note opened there again later is not scrolled again.
  const done = () =>
    store.setState((state) => {
      if (state.byTab.get(tab)?.reveal.key !== key) return state;
      const byTab = new Map(state.byTab);
      byTab.delete(tab);
      return { byTab };
    });
  store.setState((state) => ({
    asked: key,
    byTab: new Map(state.byTab).set(tab, { path, reveal: { fragment, key, done } }),
  }));
}

/** The reveal asked of a tab for the note it shows, or null. */
export function useTabReveal(
  store: RevealStore,
  { tab, path }: { tab: TabId; path: VaultPath | null },
): NoteReveal | null {
  return useStore(store, (state) => {
    const found = state.byTab.get(tab);
    return found !== undefined && found.path === path ? found.reveal : null;
  });
}
