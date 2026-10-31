import type { QueryPanelFoldStore } from '@dfai/ui';

const KEY = 'atlas.query-folds';

/** Every view's fold, as stored: the view's key to whether its query is folded. */
type Stored = Record<string, boolean>;

/**
 * Whether each saved query view's query is folded to one line, kept in
 * `localStorage` — per Mac, as a group's fold is: it is how this screen looks
 * at a view, not the view.
 *
 * Storage is read on every read, not once: each pane holds its own store, and
 * a fold made in one pane must be what the other sees when it opens the view.
 * Every access is guarded: the accessor throws in a private window and
 * wherever site data is blocked, and what is stored may have been written by
 * hand or by an older build. Neither is worth reporting — the view opens as it
 * would on a first look.
 */
export function createBrowserQueryFoldStore(): QueryPanelFoldStore {
  // Kept for the session too, so a fold still holds where storage refuses it.
  let session: Stored = {};
  return {
    read: (view) => readAll(session)[view] ?? null,
    write: (view, collapsed) => {
      session = { ...readAll(session), [view]: collapsed };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(session));
      } catch {
        // Safe to ignore: the fold holds for this session, it just will not
        // be there after the app is opened again.
      }
    },
  };
}

/** What storage holds, or what this session wrote when storage cannot be read. */
function readAll(session: Stored): Stored {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const stored: Stored = {};
    for (const [view, collapsed] of Object.entries(parsed)) {
      if (typeof collapsed === 'boolean') stored[view] = collapsed;
    }
    return stored;
  } catch {
    return session;
  }
}
