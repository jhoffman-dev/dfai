import type { GroupFoldStore } from '@dfai/ui';

const KEY = 'atlas.view-folds';

/** Every view's folded groups, as stored: the view's key to its folded group ids. */
type Stored = Record<string, readonly string[]>;

/**
 * The groups folded shut in each view, kept in `localStorage` — per Mac, as a
 * sidebar section's fold is: it is how this screen looks at a view, not the view.
 *
 * Every access is guarded: the accessor throws in a private window and wherever
 * site data is blocked, and what is stored may have been written by hand or by
 * an older build. Neither is worth reporting — the groups open, as on a first
 * look. A view with nothing folded is dropped, so the record holds only what
 * is shut.
 */
export function createBrowserGroupFoldStore(): GroupFoldStore {
  // Kept for the session too, so a fold still holds where storage refuses it.
  let session: Stored = readAll();
  return {
    read: (view) => session[view] ?? [],
    write: (view, collapsed) => {
      const others = Object.fromEntries(Object.entries(session).filter(([key]) => key !== view));
      session = collapsed.length === 0 ? others : { ...others, [view]: [...collapsed] };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(session));
      } catch {
        // Safe to ignore: the fold holds for this session, it just will not
        // be there after the app is opened again.
      }
    },
  };
}

function readAll(): Stored {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const stored: Stored = {};
    for (const [view, ids] of Object.entries(parsed)) {
      if (Array.isArray(ids))
        stored[view] = ids.filter((id): id is string => typeof id === 'string');
    }
    return stored;
  } catch {
    return {};
  }
}
