const KEY = 'atlas.type-tabs';

/** Which of a type's views was open last, keyed by vault and type. */
export interface TypeTabStore {
  readonly read: (place: { vault: string; type: string }) => string | null;
  readonly write: (place: { vault: string; type: string; path: string }) => void;
}

/** Each type's last tab, as stored: `vault \0 type` to the view's path. */
type Stored = Record<string, string>;

const keyOf = ({ vault, type }: { vault: string; type: string }) => `${vault}\u0000${type}`;

/**
 * The tab each type opens on, kept in `localStorage` — per Mac, as a fold is:
 * it is where this screen was, not something about the views. Whether that tab
 * is still the type's is the domain's to say (`landingView`), so a stale entry
 * costs nothing.
 *
 * Every access is guarded: the accessor throws in a private window and wherever
 * site data is blocked, and what is stored may have been written by hand. None
 * of that is worth reporting — the type opens on its first tab, as on a first
 * visit.
 */
export function createBrowserTypeTabStore(): TypeTabStore {
  // Kept for the session too, so the last tab still holds where storage refuses it.
  let session: Stored = readAll();
  return {
    read: (place) => session[keyOf(place)] ?? null,
    write: ({ path, ...place }) => {
      session = { ...session, [keyOf(place)]: path };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(session));
      } catch {
        // Safe to ignore: the tab is remembered for this session, it just will
        // not be after the app is opened again.
      }
    },
  };
}

function readAll(): Stored {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}
