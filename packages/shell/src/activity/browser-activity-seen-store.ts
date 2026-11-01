const KEY = 'atlas.activity-seen';

/** When the Activity page was last looked at, per vault, so its badge counts only what came after. */
export interface ActivitySeenStore {
  read(vault: string): number | null;
  write(vault: string, at: number): void;
}

/**
 * Kept in `localStorage`: whether a line has been seen is about this Mac's
 * window, not the vault. Every access is guarded — the accessor throws in a
 * private window and wherever site data is blocked — and a failure only means
 * the badge counts from the start again.
 */
export const browserActivitySeenStore: ActivitySeenStore = {
  read: (vault) => {
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
      const at = (stored as Record<string, unknown>)[vault];
      return typeof at === 'number' && Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  },
  write: (vault, at) => {
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
      const all = typeof stored === 'object' && stored !== null ? stored : {};
      window.localStorage.setItem(KEY, JSON.stringify({ ...all, [vault]: at }));
    } catch {
      // Safe to ignore: the badge counts from when the page was last opened this session.
    }
  },
};
