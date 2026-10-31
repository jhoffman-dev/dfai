import { memo, useMemo, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { activeTabOf, outlineOf, typeShownAt, type TabId, type VaultPath } from '@dfai/domain';
import {
  BacklinksPane,
  OutlinePane,
  PropertiesPane,
  RightSidebar,
  shownAsideTab,
  type AsideTab,
} from '@dfai/ui';
import { requestReveal } from '../panes/reveals.ts';
import { openNote } from '../workspace/open-place.ts';
import { useFocusedPlace } from '../workspace/workspace-store.ts';
import { useWorkspaceStores } from '../workspace/workspace-wiring.tsx';
import { hideAside, selectAsideTab, useAsideTab, useFocusedRow, withinOf } from './aside-store.ts';
import { ClaudeSeat } from './claude-seat.tsx';
import { RowAside, type RowPorts } from './row-aside.tsx';
import { useShownDoc, useShownNote, type ShownNotes } from './shown-notes.ts';
import { TypeAside, type TypeAsideWiring } from './type-aside.tsx';

/**
 * The right sidebar, wired (#306): it follows the focused tab through the
 * workspace store and reads what that tab shows — the row its table last
 * focused, else the note it is on — through selectors, never through props
 * from `App`, so a tick on Today or a keystroke elsewhere draws nothing here.
 * The Claude tab is the chat's seat (plan question 4); the Type tab is the
 * editor of the type the tab shows, on its page or one of its views (slice
 * 12). Memoised: its props are the row's ports, which change with the
 * vault's, and the type editor's wiring, so its own subscriptions are what
 * draw it.
 */
export const AsideContainer = memo(function AsideContainer({
  rows,
  types,
  onSelectType,
}: {
  rows: RowPorts;
  types: TypeAsideWiring;
  /**
   * The Type tab clicked: the window makes room for the wider editor first,
   * as Edit type does. Without it, the tab is only chosen.
   */
  onSelectType?: () => void;
}) {
  const { store, aside, shown } = useWorkspaceStores();
  const chosen = useAsideTab(aside);
  const activeTab = useStore(store, (state) => activeTabOf(state.workspace).id);
  const place = useFocusedPlace(store);
  const row = useFocusedRow(aside, { tab: activeTab, within: withinOf(place) });
  const notePath = place?.kind === 'note' ? place.path : null;
  // Properties is always offered, empty on a page with nothing selected, so
  // leaving a note for Today does not fall the aside through to Claude.
  const subject: Partial<Record<AsideTab, ReactNode>> =
    row !== null
      ? { properties: <RowAside key={row} path={row} tab={activeTab} ports={rows} aside={aside} /> }
      : notePath !== null
        ? notePanels({ shown, tab: activeTab, path: notePath })
        : { properties: <NothingSelected /> };
  const typeName = typeShownAt(place, rows.pane.savedViews);
  const type = rows.pane.types.find((each) => each.name === typeName);
  const editor =
    type === undefined
      ? {}
      : { type: <TypeAside key={type.name} type={type} ports={rows} wiring={types} /> };
  const panels = { ...editor, ...subject, claude: <ClaudeSeat /> };
  // Shown for the page at hand only: a page without an Outline does not
  // forget that the person chose Outline, so the choice is not written over.
  const tab = shownAsideTab(chosen, panels) ?? chosen;
  return (
    <RightSidebar
      tab={tab}
      panels={panels}
      onSelectTab={(next) =>
        next === 'type' && onSelectType !== undefined ? onSelectType() : selectAsideTab(aside, next)
      }
      onHide={() => hideAside(aside)}
      onEscape={focusTheWork}
    />
  );
});

/** A note tab's panels, each reading its own slice of what the tab published. */
function notePanels({ shown, tab, path }: { shown: ShownNotes; tab: TabId; path: VaultPath }) {
  const at = { shown, tab, path };
  return {
    properties: <NoteProperties {...at} />,
    backlinks: <NoteBacklinks {...at} />,
    outline: <NoteOutline {...at} />,
  };
}

interface NotePanelProps {
  shown: ShownNotes;
  tab: TabId;
  /** The tab's note, as the workspace has it; what the tab published may lag it by a render. */
  path: VaultPath;
}

function NoteProperties({ shown, tab, path }: NotePanelProps) {
  const note = useShownNote(shown, tab);
  if (note === null || note.path !== path) return <Reading />;
  // No Open or New tab at the foot: the note is the tab the aside follows.
  return (
    <PropertiesPane
      {...note.panel}
      context={note.kicker}
      title={note.title}
      path={note.path}
      {...(note.onMergeInto !== undefined && { onMergeInto: note.onMergeInto })}
    />
  );
}

function NoteBacklinks({ shown, tab, path }: NotePanelProps) {
  const { store } = useWorkspaceStores();
  const note = useShownNote(shown, tab);
  if (note === null || note.path !== path) return <Reading />;
  return (
    <BacklinksPane
      links={note.links}
      mentions={note.mentions}
      onFindMentions={note.onFindMentions}
      onLinkMention={note.onLinkMention}
      onOpen={(target) => openNote(store, target)}
    />
  );
}

function NoteOutline({ shown, tab, path }: NotePanelProps) {
  const { reveals } = useWorkspaceStores();
  // The document alone: a keystroke publishes a new one and draws this, not the rows.
  const doc = useShownDoc(shown, tab);
  const current = useStore(shown, (state) => state.byTab.get(tab)?.path === path);
  const headings = useMemo(() => (doc === null ? [] : outlineOf(doc)), [doc]);
  if (doc === null || !current) return <Reading />;
  return (
    <OutlinePane
      headings={headings}
      onJump={(at) => {
        const heading = headings.find((each) => each.at === at);
        if (heading === undefined) return;
        requestReveal(reveals, { tab, path, fragment: { kind: 'heading', heading: heading.text } });
      }}
    />
  );
}

function NothingSelected() {
  return <p className="aside__empty">Nothing selected. Open a note, or select a row in a table.</p>;
}

/** Shown for the render between a tab reaching a note and the tab publishing it. */
function Reading() {
  return <p className="aside__empty">Reading…</p>;
}

/**
 * Escape in the aside that nothing inside answered: the focus goes back to
 * the pane being worked in, whose frame is what carries the focus
 * (`PaneFrame`). A query rather than a ref: the frame is drawn by the panes'
 * container, and the aside does not hold it.
 */
function focusTheWork(): void {
  document.querySelector<HTMLElement>('.pane--focused')?.focus();
}
