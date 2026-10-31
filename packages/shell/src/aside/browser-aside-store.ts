import { ASIDE_TABS, type AsideTab } from '@dfai/ui';
import type { RememberedAside, RememberedAsides } from './aside-store.ts';

/** One key per vault, so one vault's aside never reads as another's. */
const keyFor = (vaultKey: string) => `atlas.aside:${vaultKey}`;

/** The stored shape, or null for anything else: a stale or hand-edited value opens as a first run. */
export function parseRememberedAside(stored: unknown): RememberedAside | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const { open, tab } = stored as { open?: unknown; tab?: unknown };
  if (typeof open !== 'boolean' || !ASIDE_TABS.includes(tab as AsideTab)) return null;
  return { open, tab: tab as AsideTab };
}

/**
 * The right sidebar's open state and tab, kept in `localStorage` per vault:
 * per viewer, never in the vault, never in Rust, holding nothing a secret
 * could sit in.
 *
 * Every access is guarded, as the tabs' store is: the accessor itself throws
 * in a private window and wherever site data is blocked, and a read can come
 * back empty or stale at any time. None of that is an error worth showing —
 * the aside opens shut, which is what a first run does.
 */
export const browserAsideStore: RememberedAsides = {
  read: (vaultKey) => {
    try {
      const stored = window.localStorage.getItem(keyFor(vaultKey));
      return stored === null ? null : parseRememberedAside(JSON.parse(stored));
    } catch {
      return null;
    }
  },
  write: ({ vaultKey, aside }) => {
    try {
      window.localStorage.setItem(keyFor(vaultKey), JSON.stringify(aside));
    } catch {
      // Safe to ignore: the aside still holds for this session, it just will
      // not be there next time.
    }
  },
};
