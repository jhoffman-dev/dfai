import { tabPlace, type NavigationPlace, type Tab } from '@dfai/domain';
import { TabStrip, useNoteNames, type IconName, type TabStripTab } from '@dfai/ui';
import { activateTab, closeTab, newTabIn, useActiveTabId, usePaneTabs } from './workspace-store.ts';
import { useWorkspaceStores } from './workspace-wiring.tsx';

/** What a tab with no place yet is called. */
const NEW_TAB = 'New tab';

/**
 * One pane's row of tabs, drawn from the store: a switch draws this and the
 * pane's content, nothing else. It reads the stores and the note names, both
 * steady, so the app drawn again does not draw it; a note renamed does. The
 * strip decides nothing; each click is handed to the store.
 */
export function TabStripContainer({ pane, focused }: { pane: number; focused: boolean }) {
  const { store, nameOf } = useWorkspaceStores();
  // Read for its change alone: the titles come through `nameOf`, which reads the same names.
  useNoteNames();
  const tabs = usePaneTabs(store, pane);
  const active = useActiveTabId(store, pane);
  return (
    <TabStrip
      label={`Pane ${pane + 1} tabs`}
      tabs={tabs.map((tab) => stripTab(tab, nameOf))}
      active={active}
      focused={focused}
      onActivate={(id) => activateTab(store, { pane, id })}
      onClose={(id) => closeTab(store, { pane, id })}
      onNew={() => newTabIn(store, pane)}
    />
  );
}

function stripTab(tab: Tab, nameOf: (place: NavigationPlace) => string): TabStripTab {
  const place = tabPlace(tab);
  if (place === null) return { id: tab.id, title: NEW_TAB };
  return { id: tab.id, title: nameOf(place), icon: placeIcon(place) };
}

/** The glyph beside a tab's title, by what kind of place it is on. */
function placeIcon(place: NavigationPlace): IconName {
  switch (place.kind) {
    case 'note':
      return 'doc';
    case 'type':
    case 'query':
      return 'table';
    case 'graph':
      return 'graph';
    case 'tags':
      return 'tag';
    case 'archive':
      return 'archive';
    case 'inbox':
      return 'inbox';
    case 'review':
      return 'task';
    case 'today':
      return 'sun';
    case 'automations':
      return 'bolt';
    case 'activity':
      return 'pulse';
    case 'templates':
      return 'template';
    case 'terms':
      return 'term';
    case 'skills':
      return 'skill';
    case 'library':
      return 'book';
    case 'highlights':
      return 'quote';
    case 'ask':
      return 'spark';
    case 'document':
      return 'book';
  }
}
