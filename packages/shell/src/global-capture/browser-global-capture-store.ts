import { DEFAULT_GLOBAL_CAPTURE_SHORTCUT } from '@dfai/domain';

const KEY = 'atlas.globalCaptureShortcut';
/** What is kept when the shortcut is turned off, so off is not read back as never chosen. */
const OFF = 'off';

/** The global capture shortcut chosen on this Mac: null when it is turned off. */
export interface GlobalCaptureStore {
  read(): string | null;
  write(shortcut: string | null): void;
}

/**
 * The choice, kept in `localStorage`: which keys are free is a matter of what
 * else runs on this Mac, so it is a preference of the Mac's and not of the
 * vault — and it is needed before any vault is open.
 *
 * Every access is guarded, since the accessor itself throws wherever site
 * data is blocked. A choice that cannot be read is the default, ⌃⌥N; the host
 * refuses anything stored that is not a shortcut it can register, and
 * Settings says why.
 */
export function createBrowserGlobalCaptureStore(): GlobalCaptureStore {
  // This session's choice, which holds even where storage refuses it.
  let chosen: { shortcut: string | null } | null = null;
  return {
    read: () => (chosen === null ? readStored() : chosen.shortcut),
    write: (shortcut) => {
      chosen = { shortcut };
      try {
        window.localStorage.setItem(KEY, shortcut ?? OFF);
      } catch {
        // Safe to ignore: the choice still applies for this session, and it
        // just will not be there next time.
      }
    },
  };
}

export const browserGlobalCaptureStore: GlobalCaptureStore = createBrowserGlobalCaptureStore();

function readStored(): string | null {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === OFF) return null;
    return stored === null || stored === '' ? DEFAULT_GLOBAL_CAPTURE_SHORTCUT : stored;
  } catch {
    return DEFAULT_GLOBAL_CAPTURE_SHORTCUT;
  }
}
