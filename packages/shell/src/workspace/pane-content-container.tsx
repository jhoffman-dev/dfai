import { memo, useState } from 'react';
import { keepMounted, tabPlace, type Tab, type TabId } from '@dfai/domain';
import { useChatToggle, useNoteNames } from '@dfai/ui';
import { NotePaneContainer } from '../panes/note-pane-container.tsx';
import { PageTab } from './page-tab.tsx';
import { useActiveTabId, usePaneTabs } from './workspace-store.ts';
import { useWorkspaceWiring } from './workspace-wiring.tsx';

/**
 * What one pane shows: its active tab's content, and behind it the editors
 * of the note tabs shown most recently, kept mounted and hidden so each
 * keeps its own undo (tab-model.md §2, at most `HIDDEN_EDITOR_LIMIT`). A page
 * tab is drawn only while it is the active one. The least recently shown
 * editor is let go once a fifth would be kept; it flushed as it hid, so
 * nothing is lost with it.
 */
export const PaneContentContainer = memo(function PaneContentContainer({ pane }: { pane: number }) {
  const wiring = useWorkspaceWiring();
  // Read here, outside each tab's memo, and handed down: a hidden tab is then
  // not drawn for a change of them (see `NotePaneContainer`).
  const names = useNoteNames();
  const chat = useChatToggle();
  const tabs = usePaneTabs(wiring.store, pane);
  const active = useActiveTabId(wiring.store, pane);
  const [kept, setKept] = useState<readonly TabId[]>([]);
  // The tabs the pane keeps mounted, settled in render as derived state is:
  // the shown tab first, then the note tabs shown before it.
  const mounted = keepMounted({
    kept,
    shown: active,
    present: tabs.filter(keepsEditor).map((tab) => tab.id),
  });
  if (mounted !== kept) setKept(mounted);
  return (
    <>
      {mounted.map((id) => {
        const tab = tabs.find((held) => held.id === id);
        if (tab === undefined) return null;
        const place = tabPlace(tab);
        if (place !== null && place.kind !== 'note') {
          return <PageTab key={id} wiring={wiring} pane={pane} tab={tab} place={place} />;
        }
        return (
          <NotePaneContainer
            key={id}
            wiring={wiring}
            names={names}
            chat={chat}
            pane={pane}
            tab={tab}
            hidden={id !== active}
          />
        );
      })}
    </>
  );
});

/** Note tabs keep an editor while hidden; an empty tab counts, since it becomes one. */
function keepsEditor(tab: Tab): boolean {
  const place = tabPlace(tab);
  return place === null || place.kind === 'note';
}
