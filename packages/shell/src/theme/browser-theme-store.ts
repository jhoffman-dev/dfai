import type { Theme, ThemeStore } from '@dfai/ui';

const KEY = 'atlas.theme';

const isTheme = (value: string | null): value is Theme => value === 'light' || value === 'dark';

/**
 * The theme choice, kept in `localStorage`.
 *
 * Every access is guarded: the accessor itself throws in a private window and
 * wherever site data is blocked, and a read can come back empty at any time.
 * Neither is an error worth showing — the app falls back to the system theme,
 * which is what it would have done on a first run anyway. A choice made this
 * session holds even where storage refuses it, as in
 * `browser-image-placement-store.ts`; a choice another window makes is
 * heard through the `storage` event and taken over.
 */
export const browserThemeStore: ThemeStore = createBrowserThemeStore();

export function createBrowserThemeStore(): ThemeStore {
  // What this window last settled on — read from storage once, then kept
  // here: `null` inside is "cleared", which storage cannot say apart from
  // "never chosen" when it refuses the write.
  let session: { readonly choice: Theme | null } | null = null;
  const listeners = new Set<() => void>();
  const tell = () => listeners.forEach((listener) => listener());

  // Another window's write to the key (or its clearing of localStorage,
  // which has no key): taken as this window's choice too, subscribers or
  // not, so a read after it answers the same as that window's. One listener
  // for the store's lifetime: the app makes a single store, and it lives as
  // long as the window does, so there is nothing to remove it for.
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key !== KEY && event.key !== null) return;
    session = { choice: isTheme(event.newValue) ? event.newValue : null };
    tell();
  });

  return {
    read: () => (session ??= { choice: readStored() }).choice,
    write: (theme) => {
      session = { choice: theme };
      try {
        window.localStorage.setItem(KEY, theme);
      } catch {
        // Safe to ignore: the choice still applies for this session, it just
        // will not be there next time.
      }
      tell();
    },
    clear: () => {
      session = { choice: null };
      try {
        window.localStorage.removeItem(KEY);
      } catch {
        // Safe to ignore, as for a write: the system theme applies for this
        // session, and the stored choice comes back next time.
      }
      tell();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function readStored(): Theme | null {
  try {
    const stored = window.localStorage.getItem(KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}
