import {
  SelectionBar,
  TableView,
  type CreateRelated,
  type GroupFolds,
  type OpenHow,
  type OverlaySlot,
  type PeekRequest,
} from '@dfai/ui';
import type { ViewChoosing } from '../archive/use-view-choosing.ts';
import { useTableAsPending } from '../query/use-pending-cards.ts';
import type { useSavedView } from '../query/use-saved-view.ts';
import { editableSchemaOf } from './table-schema.ts';

type SavedView = ReturnType<typeof useSavedView>;

/**
 * A saved view drawn as its table, with its cells edited in place (#300): a
 * cell committed is drawn as committed before the index reads it back, a
 * commit that failed or was refused is said over the table — still drawn —
 * until the next, and a cell's picker holds the pane's popup slot, so ⌘K
 * over it closes it. Only this subscribes to the view's pending edits, so a
 * commit draws the table, not the pane and the toolbar around it.
 */
export function ViewTable({
  view,
  choosing,
  folds,
  onOpenNote,
  onPeek,
  onNewNote,
  onRowFocus,
  onCreateRelated,
  pickerSlot,
}: {
  view: SavedView;
  choosing: ViewChoosing;
  folds: GroupFolds;
  onOpenNote: (path: string, how?: OpenHow) => void;
  /** Given, a row's name clicked plainly peeks its note (slice 6b). */
  onPeek?: (request: PeekRequest) => void;
  onNewNote: () => void;
  onRowFocus?: (path: string) => void;
  /** "New <type>…" in a relation cell's picker. */
  onCreateRelated?: CreateRelated;
  /** The cell picker's open state, held by the app's one-overlay rule. */
  pickerSlot?: OverlaySlot;
}) {
  const shown = useTableAsPending({ pending: view.pendingBoard.pending, result: view.result });
  // Spread rather than passed, so a type with no done option draws no boxes.
  const ticks = view.ticks === undefined ? {} : { ticks: view.ticks };
  const choose = choosing.on && view.display.layout === 'table';
  return (
    <>
      {choose && (
        <SelectionBar count={choosing.count} actions={choosing.actions} onClear={choosing.clear} />
      )}
      {shown.failure !== null && view.error === null && (
        <p className="table__error" role="alert">
          {shown.failure}
        </p>
      )}
      <TableView
        result={shown.result}
        sorts={view.query?.sorts ?? []}
        error={view.error}
        schema={editableSchemaOf(view.type, view.query?.type ?? '')}
        onOpenNote={onOpenNote}
        {...(onPeek !== undefined && { onPeek })}
        onEditCell={view.editCell}
        relationChoices={view.relationChoices}
        onWantRelationChoices={view.wantRelationChoices}
        relationChoiceProblems={view.relationChoiceProblems}
        readHeldCell={view.readHeldCell}
        onToggleSort={view.toggleSort}
        onNewNote={onNewNote}
        hiddenColumns={view.hidden}
        {...ticks}
        {...(onCreateRelated !== undefined && { onCreateRelated })}
        {...(pickerSlot !== undefined && { pickerSlot })}
        {...(onRowFocus !== undefined && { onRowFocus })}
        {...(choose && { selection: choosing.selection })}
        {...(view.display.groupBy !== null && {
          grouping: {
            groups: view.groups,
            collapsed: folds.collapsed,
            onToggle: folds.onToggle,
            onNew: (chain) => {
              // A failed create is shown as the view's error by `addInGroup` itself.
              void view.addInGroup(chain).then((path) => {
                if (path !== null) onOpenNote(path);
              });
            },
          },
        })}
      />
    </>
  );
}
