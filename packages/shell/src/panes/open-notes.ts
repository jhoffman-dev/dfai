import type { EntryMove } from '@dfai/domain';
import type { LinkUpdatePanes, OpenEditorsPort, OpenNotes } from '@dfai/application';
import type { PaneEditors } from './open-editors.ts';

/**
 * No tab: a write from outside the app was made by none of them, so every tab
 * holding the note is one of the "others" that should catch up.
 */
const NO_TAB = '';

/** The panes, as a request from outside the app reaches them (ADR-0016). */
export function openNotesIn(editors: PaneEditors): OpenNotes {
  return {
    state: (path) => editors.stateOf(path),
    setPropertiesIfOpen: (args) => editors.setPropertiesIfOpen(args),
    reload: (path) => editors.reloadOthers({ tabId: NO_TAB, path }),
  };
}

/**
 * The panes, as moving or deleting a note reaches them. A move re-points the
 * editors and the layout together, so no render has a pane holding a path the
 * note has left.
 */
export function movingEditorsIn(
  editors: PaneEditors,
  followLayout: (move: EntryMove) => void,
): OpenEditorsPort & Pick<LinkUpdatePanes, 'reload'> {
  return {
    state: (path) => editors.stateOf(path),
    flush: (paths) => editors.flushHolding(paths),
    follow: (move) => {
      editors.follow(move);
      followLayout(move);
    },
    abandon: (paths) => editors.abandon(paths),
    dirtyPaths: () => editors.dirtyPaths(),
    reload: (path) => editors.reloadOthers({ tabId: NO_TAB, path }),
  };
}
