import { useEffect, useMemo, useRef, type ComponentProps } from 'react';
import { useStore } from 'zustand';
import { createVaultPath, isPersonType, typeShownAt } from '@dfai/domain';
import { typeTableScope } from '@dfai/application';
import { clearRow, focusRow, hideAside, typeEditorShown, withinOf } from '../aside/aside-store.ts';
import { LoadedLater } from '../page-frame-fallback.tsx';
import { typePage } from '../pages-on-first-use.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { useLastReadFailed, useScopedIndexKey } from '../reads/use-scoped-index-key.ts';
import { openPeek } from '../overlay-store.ts';
import { rowPeek } from '../overlay.ts';
import { activePlace } from '../workspace/workspace-store.ts';
import { useWorkspaceStores } from '../workspace/workspace-wiring.tsx';
import { typeTabsShown } from './type-tabs.ts';
import { useTypeTable } from './use-type-table.ts';
import { rowPaths, useChosenPeople, type ChosenPeopleMerge } from '../people/use-chosen-people.ts';

const TypePage = typePage.Component;

type TypePageProps = ComponentProps<typeof TypePage>;

/**
 * What a type's page needs from the window beyond what every page is
 * handed: showing the type's editor, which is the right sidebar's, and what
 * making and templating a note of the type go through, which are the
 * window's dialogs and commands.
 */
export interface TypeWiring {
  /** Shows the type's editor in the right sidebar, making room for it. */
  readonly onEditType: (name: string) => void;
  readonly onNewNote: TypePageProps['onNewNote'];
  readonly onEditTemplate: TypePageProps['onEditTemplate'];
  /** Opens the list of people who may be one (#464), offered on the Person type's page. */
  readonly onFindDuplicates: () => void;
  /** Merging the people chosen in the Person type's table (#464). */
  readonly peopleMerge: ChosenPeopleMerge;
}

/**
 * A type's page as a tab (tab-model.md, PR B): its table is read here, for
 * the type the place names, so a type page in either pane draws its own
 * table — not the one type the window used to assemble. One editor per
 * type: its queued changes and open question belong to that file.
 */
export function TypeContainer({
  wiring,
  tabId,
  chrome,
  name,
}: PageContainerProps & { name: string }) {
  const { pages, pane } = wiring;
  const { aside, store } = useWorkspaceStores();
  // The row this tab's table held goes with the tab.
  useEffect(() => () => clearRow(aside, tabId), [aside, tabId]);
  // Read again for news of this type's notes and the type files alone (#327), or
  // any news after a failed read (#424): a view not yet rebuilt is rebuilt on news.
  const scope = useMemo(() => typeTableScope(name), [name]);
  const [failed, tellFailed] = useLastReadFailed();
  const indexKey = useScopedIndexKey({
    status: pane.indexStatus,
    vault: pane.vault,
    reader: ['type', name],
    scope,
    failed,
  });
  const { onEditType, onNewNote, onEditTemplate, onFindDuplicates, peopleMerge } = pages.type;
  // Pressed while the aside shows this type's editor: on its Type tab, with
  // the focused tab on this type, here or in the other pane.
  const typeTabShown = useStore(aside, typeEditorShown);
  const showsThisType = useStore(
    store,
    (state) => typeShownAt(activePlace(state.workspace), pane.savedViews) === name,
  );
  const editing = typeTabShown && showsThisType;
  // A press in the other pane focuses this one on its mousedown, which turns
  // the aside to this type before the click lands: the click goes by what the
  // button showed as the pointer came down. A key press has no such start.
  const pressedAtStart = useRef<boolean | null>(null);
  const table = useTypeTable({
    fs: pages.ports.fs,
    markdown: pane.notes.markdown,
    index: pane.index,
    types: pane.types,
    typeName: name,
    indexKey,
    onChanged: pane.onChanged,
    editors: pane.editors,
    activity: pane.activity,
  });
  tellFailed(table.error);
  const tableRows = useMemo(() => rowPaths(table.result), [table.result]);
  const people = useChosenPeople({
    tab: tabId,
    resetKey: name,
    merge: isPersonType(name) ? peopleMerge : null,
    present: tableRows,
  });
  return (
    <LoadedLater chrome={chrome}>
      <TypePage
        key={name}
        table={table}
        types={pane.types}
        editing={editing}
        onEditTypeStart={() => {
          pressedAtStart.current = editing;
        }}
        onEditType={() => {
          const was = pressedAtStart.current ?? editing;
          pressedAtStart.current = null;
          if (was) hideAside(aside);
          else onEditType(name);
        }}
        ports={{
          fs: pages.ports.fs,
          markdown: pane.notes.markdown,
          index: pane.index,
          openNotes: pane.editors,
        }}
        onSaved={pane.onTypeSaved}
        onOpenNote={pages.openNote}
        onPeek={({ path, order }, within) =>
          openPeek(
            wiring.overlays,
            rowPeek({
              path: createVaultPath(path),
              order: order.map(createVaultPath),
              within,
            }),
          )
        }
        onNewNote={onNewNote}
        tabs={
          table.type === null
            ? []
            : typeTabsShown(
                { savedViews: pane.savedViews, takenViewPaths: pane.viewPaths },
                table.type,
              )
        }
        tabEditing={pane.typeTabs({ typeName: name, onOpenView: pages.openNote })}
        onOpenView={pages.openNote}
        onEditTemplate={onEditTemplate}
        {...(isPersonType(name) && { onFindDuplicates })}
        {...(people !== null && { choosing: people })}
        // The row the table's focus is in, for the aside: held against this type's page.
        onRowFocus={(path) =>
          focusRow(aside, {
            tab: tabId,
            path: createVaultPath(path),
            within: withinOf({ kind: 'type', name }),
          })
        }
        {...chrome}
      />
    </LoadedLater>
  );
}
