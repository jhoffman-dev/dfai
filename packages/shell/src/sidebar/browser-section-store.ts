import { parseCollapsedSections, type SidebarSectionId } from '@dfai/domain';
import type { SectionStore } from '@dfai/ui';

const KEY = 'atlas.sidebar.collapsed';

/**
 * Which sidebar sections are shut, kept in `localStorage`.
 *
 * Every access is guarded, as the theme's store is: the accessor itself throws
 * in a private window and wherever site data is blocked, and a read can come
 * back empty or stale at any time. None of that is an error worth showing —
 * the sections open, which is what a first run does anyway.
 */
export const browserSectionStore: SectionStore = {
  read: () => {
    try {
      const stored = window.localStorage.getItem(KEY);
      return stored === null ? null : parseCollapsedSections(JSON.parse(stored));
    } catch {
      return null;
    }
  },
  write: (collapsed: readonly SidebarSectionId[]) => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(collapsed));
    } catch {
      // Safe to ignore: the sections still behave for this session, they just
      // will not come back that way next time.
    }
  },
};
