import { parseHiddenSections, type SidebarSectionId } from '@dfai/domain';
import type { HiddenSectionStore } from './use-hidden-sections.ts';

const KEY = 'atlas.sidebar.hidden';

/**
 * Which sidebar sections are left out (#902), kept in `localStorage` on this
 * machine, as the collapsed ones are.
 *
 * Every access is guarded: the accessor itself throws in a private window and
 * wherever site data is blocked. A read that fails, or finds nothing or
 * nonsense, is the domain's default — Pages hidden — which is what a first run
 * shows anyway.
 */
export const browserHiddenSectionStore: HiddenSectionStore = {
  read: () => {
    try {
      const stored = window.localStorage.getItem(KEY);
      return parseHiddenSections(stored === null ? undefined : JSON.parse(stored));
    } catch {
      return parseHiddenSections(undefined);
    }
  },
  write: (hidden: readonly SidebarSectionId[]) => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(hidden));
    } catch {
      // Safe to ignore: the choice still holds for this session; it just will
      // not come back next time.
    }
  },
};
