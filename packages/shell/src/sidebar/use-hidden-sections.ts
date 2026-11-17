import { useCallback, useEffect, useState } from 'react';
import { withSectionShown, type SidebarSectionId } from '@dfai/domain';

/** Where the sections left out of the sidebar are remembered; a read always answers, with the default when nothing was kept. */
export interface HiddenSectionStore {
  readonly read: () => readonly SidebarSectionId[];
  readonly write: (hidden: readonly SidebarSectionId[]) => void;
  /** Calls `changed` when another window changes what is kept; returns how to stop. Left out, nothing is heard. */
  readonly subscribe?: (changed: () => void) => () => void;
}

export interface HiddenSections {
  /** The sections the sidebar leaves out; the same list until it changes. */
  readonly hidden: readonly SidebarSectionId[];
  readonly isShown: (section: SidebarSectionId) => boolean;
  /** Shows or hides one section, and remembers the choice. */
  readonly setShown: (section: SidebarSectionId, shown: boolean) => void;
}

/**
 * Which sections the sidebar leaves out (#902), read once and remembered on
 * every change. The window holds it, so the header's menu, the palette and the
 * sidebar all see one answer.
 */
export function useHiddenSections(store: HiddenSectionStore): HiddenSections {
  const [hidden, setHidden] = useState<readonly SidebarSectionId[]>(() => store.read());
  // Another window's choice is followed; an effect, so opening a vault draws nothing more.
  useEffect(() => store.subscribe?.(() => setHidden(store.read())), [store]);

  const isShown = useCallback((section: SidebarSectionId) => !hidden.includes(section), [hidden]);

  const setShown = useCallback(
    (section: SidebarSectionId, shown: boolean) => {
      const next = withSectionShown({ hidden, section, shown });
      if (next === null) return;
      // Outside the state updater on purpose: React may run an updater twice.
      store.write(next);
      setHidden(next);
    },
    [hidden, store],
  );

  return { hidden, isShown, setShown };
}
