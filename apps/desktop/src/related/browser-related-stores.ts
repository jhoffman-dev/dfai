import type { DismissedRelatedStore } from '@dfai/application';

const DISMISSED = 'atlas.related-dismissed:';
const OPEN = 'atlas.related-open';

/** Whether the Related notes section was left open, so the next note opens it the same way. */
export interface RelatedPanelMemory {
  isOpen(): boolean;
  setOpen(open: boolean): void;
}

/** Each note's dismissed related notes, as stored: note path to the paths dismissed. */
type Stored = Record<string, readonly string[]>;

/**
 * The related notes dismissed in one vault, kept in `localStorage` — per Mac,
 * as a view's folded groups are (see `DismissedRelatedStore` for why).
 *
 * Every access is guarded: the accessor throws in a private window and
 * wherever site data is blocked, and what is stored may have been written by
 * hand or by an older build. Neither is worth reporting — a dismissal then
 * holds for the session only.
 */
export function createBrowserDismissedRelatedStore(vault: string): DismissedRelatedStore {
  const key = `${DISMISSED}${vault}`;
  // Kept for the session too, so a dismissal still holds where storage refuses it.
  let session: Stored = readAll(key);
  return {
    dismissed: (note) => new Set(session[note] ?? []),
    dismiss: (note, related) => {
      const already = session[note] ?? [];
      if (already.includes(related)) return;
      session = { ...session, [note]: [...already, related] };
      try {
        window.localStorage.setItem(key, JSON.stringify(session));
      } catch {
        // Safe to ignore: the dismissal holds for this session, it just will not
        // be there after the app is opened again.
      }
    },
  };
}

function readAll(key: string): Stored {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const stored: Stored = {};
    for (const [note, paths] of Object.entries(parsed)) {
      if (!Array.isArray(paths)) continue;
      stored[note] = paths.filter((path): path is string => typeof path === 'string');
    }
    return stored;
  } catch {
    return {};
  }
}

/** Whether the Related notes section is left open, on this Mac; closed until it is first opened. */
export const browserRelatedPanelMemory: RelatedPanelMemory = {
  isOpen: () => {
    try {
      return window.localStorage.getItem(OPEN) === 'true';
    } catch {
      return false;
    }
  },
  setOpen: (open) => {
    try {
      window.localStorage.setItem(OPEN, String(open));
    } catch {
      // Safe to ignore: the section is still open or shut for this note; the next starts closed.
    }
  },
};
