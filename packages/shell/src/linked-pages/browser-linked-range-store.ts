import { LINKED_RANGES, type LinkedRange, type LinkedSectionId } from '@dfai/domain';
import type { LinkedRangeStore } from '@dfai/application';

const KEY = 'atlas.linked-ranges';

type Ranges = Partial<Record<LinkedSectionId, LinkedRange>>;

/** Every page type's sections, as stored: the type to each section's range. */
type Stored = Record<string, Ranges>;

/**
 * Which of recent and all each section of a linked page (P30-06) was left
 * on, per page type, kept in `localStorage` — per Mac, as a view's folded
 * groups are: it is how this screen reads a person's page, not the page.
 *
 * Every access is guarded: the accessor throws in a private window and
 * wherever site data is blocked, and what is stored may have been written by
 * hand or by an older build. Neither is worth reporting — the sections show
 * the last 30 days, as on a first look.
 */
export function createBrowserLinkedRangeStore(): LinkedRangeStore {
  // Kept for the session too, so a choice still holds where storage refuses it.
  let session: Stored = readAll();
  return {
    read: (pageType) => session[pageType] ?? {},
    write: (pageType, section, range) => {
      session = { ...session, [pageType]: { ...session[pageType], [section]: range } };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(session));
      } catch {
        // Safe to ignore: the choice holds for this session, it just will not
        // be there after the app is opened again.
      }
    },
  };
}

const isRange = (value: unknown): value is LinkedRange =>
  LINKED_RANGES.some((range) => range === value);

function readAll(): Stored {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const stored: Stored = {};
    for (const [pageType, ranges] of Object.entries(parsed)) {
      if (typeof ranges !== 'object' || ranges === null || Array.isArray(ranges)) continue;
      stored[pageType] = Object.fromEntries(
        Object.entries(ranges).filter(([, range]) => isRange(range)),
      );
    }
    return stored;
  } catch {
    return {};
  }
}
