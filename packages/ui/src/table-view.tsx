import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import type { OpenHow } from './open-how.ts';
import type { PeekRequest } from './peek/peek-request.ts';
import {
  countLabel,
  groupTotals,
  humanizeKey,
  newNoteLabel,
  optionColorsByKey,
  tableArrangement,
  toBoardRows,
  type BoardRow,
  type GroupLine,
  type OptionColors,
  type PropertyDef,
  type PropertyKind,
  type QuerySort,
} from '@dfai/domain';
import type { CellEdit, CellEditing, CellEditorHooks } from './cells/cell-editing.ts';
import { CellPickers, picksFrom } from './cells/cell-pickers.tsx';
import { useCellEditing } from './cells/use-cell-editing.ts';
import { usePickerSlot } from './cells/use-picker-slot.ts';
import { useAnchorWatch } from './cells/use-anchor-watch.ts';
import { useHeldCell, type ReadHeldCell } from './cells/use-held-cell.ts';
import type { OverlaySlot } from './overlay-slot.ts';
import type { DoneTicks } from './done-checkbox.tsx';
import { FlatRows } from './flat-rows.tsx';
import {
  GroupedRows,
  rowOrder,
  useGroupLines,
  type LinePlace,
  type TableGrouping,
} from './grouped-rows.tsx';
import { Icon } from './icon.tsx';
import { SelectAllBox, type RowSelection } from './row-selection.tsx';
import { useSteadyCallback } from './steady-callback.ts';
import { sameEntries, sameItems, useSteadyValue } from './steady-value.ts';
import type { CreateRelated, RelationChoice } from './properties-panel.tsx';
import { editableColumns, leadCellCount, TableRow, TITLE, type RowLook } from './table-cells.tsx';
import { delayedSpinner } from './delayed-spinner.tsx';

export interface TableResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly truncated: boolean;
  readonly sql: string;
}

/** What the table knows about the view's type, to head and fill its columns. */
export interface TableSchema {
  /** The declared kind of each property. */
  readonly kinds: Readonly<Record<string, PropertyKind>>;
  /** The declared label of each property; a key without one is humanised. */
  readonly labels: Readonly<Record<string, string>>;
  /** The type's name, for "New task" and "177 tasks". */
  readonly noun: string;
  /**
   * The declared property under each key, for the editor its cells open: a
   * select's options, a relation's targets. Left out, those cells edit as text.
   */
  readonly properties?: Readonly<Record<string, PropertyDef>>;
  /**
   * The colours the type chose for each select's options, by key
   * (`optionColorsByKey`). Left out, they are read from `properties`; an
   * option with none is coloured by its value.
   */
  readonly colors?: Readonly<Record<string, OptionColors>>;
  /**
   * Whether its `priority` is a task's 1 to 4 — a task table in a vault that
   * ranks its tasks (`ranksTasks`) — drawn as the P1 to P4 pill (#913). Left
   * out, it is a number like any other.
   */
  readonly ranksPriority?: boolean;
}

const NO_SCHEMA: TableSchema = { kinds: {}, labels: {}, noun: '' };
const NO_PROPERTIES: Readonly<Record<string, PropertyDef>> = {};
const NO_CHOICES: readonly RelationChoice[] = [];

/** What the index hands back beside the properties, which are not columns to read. */
const HIDDEN_COLUMNS: readonly string[] = ['path', 'summary'];

export interface TableViewProps {
  readonly result: TableResult | null;
  readonly sorts: readonly QuerySort[];
  readonly error: string | null;
  readonly schema?: TableSchema;
  /** Opens a row's note; `how` is where the click asked for it, when it said. */
  readonly onOpenNote: (path: string, how?: OpenHow) => void;
  /**
   * Given, a row's name clicked plainly peeks its note instead of opening it
   * (slice 6b), handed every row in the order the table shows them. A click
   * asking for a tab or a split still opens it, through `onOpenNote`.
   */
  readonly onPeek?: (request: PeekRequest) => void;
  /**
   * One write per commit: what a cell's editor typed or picked, typed by the
   * column's kind — text, a number, a tick, a day, a link or links. Left out,
   * the cells are read-only: a SQL result's columns need not be properties.
   * A method, not a property, so a handler declared for text alone — all a
   * SQL view's cells, which have no kind, ever report — is still accepted:
   * a method's parameter is checked both ways.
   */
  onEditCell?(edit: CellEdit): unknown;
  /** The notes each relation column may link, by column, for its picker. */
  readonly relationChoices?: Readonly<Record<string, readonly RelationChoice[]>>;
  /** Given, a relation's picker offers "New <type>…". */
  readonly onCreateRelated?: CreateRelated;
  /** Told a relation column's picker has opened, so its notes can be read once wanted. */
  readonly onWantRelationChoices?: (column: string) => void;
  /** Why a relation column's notes could not be read, by column: said in its picker. */
  readonly relationChoiceProblems?: Readonly<Record<string, string>>;
  /**
   * Reads what a cell holding several values holds from its note — the row
   * has them joined into one text, which is never split (#425).
   */
  readonly readHeldCell?: ReadHeldCell;
  /** A cell's picker's open state, held by the app's one-overlay rule. */
  readonly pickerSlot?: OverlaySlot;
  readonly onToggleSort: (column: string) => void;
  /** Adds a note of the view's type; the footer offers it when given. */
  readonly onNewNote?: () => void;
  /** Given when the view's type can be ticked done: each row leads with a box. */
  readonly ticks?: DoneTicks;
  /** Columns the result carries for the layout's sake, not the view's — a status a box reads. */
  readonly hiddenColumns?: readonly string[];
  /** Given while rows can be chosen: each row leads with a box to choose it by. */
  readonly selection?: RowSelection;
  /** Given while the view groups: its rows drawn under group header rows. */
  readonly grouping?: TableGrouping;
  /**
   * Told the row the focus landed in — a cell clicked, tabbed to, or edited —
   * for what follows the focused row (the right sidebar). The rows are not
   * drawn again for it: it reaches them through the steady look.
   */
  readonly onRowFocus?: (path: string) => void;
}

/**
 * A view's results as a table.
 *
 * Editing a cell changes that note's frontmatter — the table is a way of looking
 * at the files, not a place data lives. The SQL behind it is one "Show SQL"
 * away, in the page's "…" menu.
 */
export function TableView({
  result,
  sorts,
  error,
  schema = NO_SCHEMA,
  onOpenNote,
  onPeek,
  onEditCell,
  relationChoices,
  onCreateRelated,
  onWantRelationChoices,
  relationChoiceProblems,
  readHeldCell,
  pickerSlot,
  onToggleSort,
  onNewNote,
  ticks,
  hiddenColumns = [],
  selection,
  grouping,
  onRowFocus,
}: TableViewProps) {
  if (error !== null) {
    return (
      <p className="table__error" role="alert">
        {error}
      </p>
    );
  }
  if (result === null) return delayedSpinner('Running the view…');
  return (
    <TableSheet
      result={result}
      sorts={sorts}
      schema={schema}
      onOpenNote={onOpenNote}
      {...(onPeek !== undefined && { onPeek })}
      onToggleSort={onToggleSort}
      hiddenColumns={hiddenColumns}
      {...(onEditCell !== undefined && { onEditCell })}
      {...(relationChoices !== undefined && { relationChoices })}
      {...(onCreateRelated !== undefined && { onCreateRelated })}
      {...(onWantRelationChoices !== undefined && { onWantRelationChoices })}
      {...(relationChoiceProblems !== undefined && { relationChoiceProblems })}
      {...(readHeldCell !== undefined && { readHeldCell })}
      {...(pickerSlot !== undefined && { pickerSlot })}
      {...(onNewNote !== undefined && { onNewNote })}
      {...(ticks !== undefined && { ticks })}
      {...(selection !== undefined && { selection })}
      {...(grouping !== undefined && { grouping })}
      {...(onRowFocus !== undefined && { onRowFocus })}
    />
  );
}

/** The sheet itself, once there is a result to draw. */
function TableSheet({
  result,
  sorts,
  schema,
  onOpenNote,
  onPeek,
  onEditCell,
  relationChoices,
  onCreateRelated,
  onWantRelationChoices,
  relationChoiceProblems,
  readHeldCell,
  pickerSlot,
  onToggleSort,
  onNewNote,
  ticks,
  hiddenColumns,
  selection,
  grouping,
  onRowFocus,
}: Omit<TableViewProps, 'result' | 'error' | 'schema' | 'hiddenColumns'> & {
  result: TableResult;
  schema: TableSchema;
  hiddenColumns: readonly string[];
}) {
  // State, not a ref: the rows' virtualiser looks for its scroller in a
  // layout effect, which runs before the sheet's ref is set. With a ref it
  // found none, and drew a guessed screenful that scrolling never moved,
  // until something else happened to draw the table again.
  const [sheet, setSheet] = useState<HTMLDivElement | null>(null);

  const pathAt = result.columns.indexOf('path');
  // The path names a row and the summary is a card's aid; neither is a column.
  const shown = useSteadyValue(
    result.columns.filter(
      (column) => !HIDDEN_COLUMNS.includes(column) && !hiddenColumns.includes(column),
    ),
    sameItems,
  );
  // Once per result: the window draws the open table again for whatever else
  // happens in it — every key typed in ⌘K — and a table can hold hundreds (#217).
  const { columns, rows: read } = result;
  const rows = useMemo(() => toBoardRows({ columns, rows: read }), [columns, read]);
  const paths = useMemo(
    () => (pathAt === -1 ? [] : read.map((row) => String(row[pathAt] ?? ''))),
    [pathAt, read],
  );
  const grouped = grouping !== undefined && grouping.groups.length > 0;
  const lines = useGroupLines(grouped ? grouping : undefined);
  // Read on a shift-click or a Tab only, so the rows are not drawn again for it.
  const order = () => (grouped ? rowOrder(lines) : rows.map((row) => row.path));
  const kinds = useSteadyValue(schema.kinds, sameEntries);
  const properties = useSteadyValue(schema.properties ?? NO_PROPERTIES, sameEntries);
  const colors = useSteadyValue(
    schema.colors ?? optionColorsByKey(Object.values(properties)),
    sameEntries,
  );
  const { editing, editor, dismiss } = useCellEditing({
    onEditCell,
    paths,
    order,
    columns: () => editableColumns({ shown, kinds, properties }),
    valueAt: (at) => rows.find((row) => row.path === at.path)?.values[at.column],
  });
  const look = useRowLook({
    shown,
    kinds,
    labels: useSteadyValue(schema.labels, sameEntries),
    properties,
    colors,
    ranksPriority: schema.ranksPriority === true,
    onOpenNote,
    onPeek,
    editor,
    ticks,
    selection,
    order,
    onRowFocus,
  });
  // The property the editing cell is under, when it edits in a picker.
  const picker = editing === null ? undefined : properties[editing.column];
  const picking = editor !== undefined && picksFrom(picker);
  usePickerSlot({ picking, slot: pickerSlot, dismiss });
  useAnchorWatch({ picking, anchor: editorAnchor(editor), scroller: sheet, dismiss });
  useWantedChoices(picker, onWantRelationChoices);
  const held = useHeldCell({
    editing,
    def: picker,
    rowValue:
      editing === null
        ? undefined
        : rows.find((row) => row.path === editing.path)?.values[editing.column],
    read: readHeldCell,
  });

  return (
    <div className="table">
      <div className="table__sheet" ref={setSheet}>
        {result.rows.length === 0 ? (
          <p className="table__empty">Nothing matches this view yet.</p>
        ) : (
          <TableGrid
            head={
              <TableHead
                columns={shown}
                sorts={sorts}
                schema={schema}
                onToggleSort={onToggleSort}
                ticked={ticks !== undefined}
                choose={
                  selection === undefined ? null : (
                    <SelectAllBox paths={paths} selection={selection} />
                  )
                }
              />
            }
            rows={rows}
            lines={lines}
            look={look}
            editing={editing}
            noun={schema.noun}
            scroller={sheet}
            {...(ticks !== undefined && { ticks })}
            {...(selection !== undefined && { selection })}
            {...(grouped && { grouping })}
          />
        )}
      </div>
      {editing !== null && editor !== undefined && picker !== undefined && picking && (
        <CellPickers
          // One picker per cell: a Tab on to the next cell's picker opens a
          // fresh one, carrying no filter or highlight over from the last.
          key={`${editing.path}\u0000${editing.column}`}
          editing={editing}
          def={picker}
          held={held}
          choices={relationChoices?.[editing.column] ?? NO_CHOICES}
          choicesProblem={relationChoiceProblems?.[editing.column] ?? null}
          editor={editor}
          onOpenNote={onOpenNote}
          {...(onCreateRelated !== undefined && { onCreateRelated })}
        />
      )}
      <TableFooter
        result={result}
        sorts={sorts}
        schema={schema}
        grouping={grouped ? grouping : undefined}
        {...(onNewNote !== undefined && { onNewNote })}
      />
    </div>
  );
}

const NO_ANCHOR: RefObject<HTMLElement | null> = { current: null };

/** The cell a picker hangs from, or none for a table whose cells are read only. */
function editorAnchor(editor: CellEditorHooks | undefined): RefObject<HTMLElement | null> {
  return editor?.anchor ?? NO_ANCHOR;
}

/** Asks for a relation column's notes as its picker opens: nothing is read for a table no one links from. */
function useWantedChoices(
  picker: PropertyDef | undefined,
  want: ((column: string) => void) | undefined,
) {
  const column = picker?.kind === 'relation' ? picker.key : null;
  const ask = useSteadyCallback((key: string) => want?.(key));
  useEffect(() => {
    if (column !== null) ask(column);
  }, [column, ask]);
}

/**
 * The 30px footer (Table.dc.html): how many rows, how many in each group,
 * and how the table is arranged — "Grouped by status · sorted by phase".
 */
function TableFooter({
  result,
  sorts,
  schema,
  grouping,
  onNewNote,
}: {
  result: TableResult;
  sorts: readonly QuerySort[];
  schema: TableSchema;
  grouping: TableGrouping | undefined;
  onNewNote?: () => void;
}) {
  const label = (key: string) => columnLabel(key, schema);
  const groupedBy = grouping?.groups[0]?.field;
  const arrangement = tableArrangement({
    groupedBy: groupedBy === undefined ? null : label(groupedBy),
    sortedBy: sorts.map((sort) => ({ label: label(sort.key), direction: sort.direction })),
  });
  return (
    <footer className="table__footer">
      {onNewNote !== undefined && (
        <button type="button" className="table__new" onClick={onNewNote}>
          <Icon name="plus" size={14} />
          {newNoteLabel(schema.noun)}
        </button>
      )}
      <span className="table__count">
        {countLabel({ count: result.rows.length, noun: schema.noun })}
        {result.truncated && ' (more were left out)'}
      </span>
      {grouping !== undefined &&
        groupTotals(grouping.groups).map((total, at) => (
          // By place: two groups can read the same ("Done" and "done").
          <span key={at} className="table__total">
            {total}
          </span>
        ))}
      {arrangement !== null && <span className="table__arrangement">{arrangement}</span>}
    </footer>
  );
}

/** A column's heading: "Name" for the title, else the label its type declares, else its key humanised. */
function columnLabel(column: string, schema: TableSchema): string {
  return column === TITLE ? 'Name' : (schema.labels[column] ?? humanizeKey(column));
}

/**
 * What every row shares, the same object from one render to the next while
 * the columns and what can be done stay the same: the window draws the open
 * table again for every key typed in ⌘K, each time with handlers made anew,
 * and a new look would draw every row again for it (#238).
 */
function useRowLook({
  shown,
  kinds,
  labels,
  properties,
  colors,
  ranksPriority,
  onOpenNote,
  onPeek,
  editor,
  ticks,
  selection,
  order,
  onRowFocus,
}: {
  shown: readonly string[];
  kinds: RowLook['kinds'];
  labels: RowLook['labels'];
  properties: RowLook['properties'];
  colors: RowLook['colors'];
  ranksPriority: boolean;
  onOpenNote: TableViewProps['onOpenNote'];
  onPeek: TableViewProps['onPeek'];
  editor: CellEditorHooks | undefined;
  ticks: DoneTicks | undefined;
  selection: RowSelection | undefined;
  /** The rows' paths in the order the table shows them, for a shift-click's range. */
  order: () => readonly string[];
  onRowFocus: TableViewProps['onRowFocus'];
}): RowLook {
  const open = useSteadyCallback(onOpenNote);
  // The order is read as the row is clicked, so the rows are not drawn again for it.
  const openRow = useSteadyCallback((path: string, how: OpenHow) => {
    if (how === 'here' && onPeek !== undefined) onPeek({ path, order: order() });
    else onOpenNote(path, how);
  });
  const focusRow = useSteadyCallback((path: string) => onRowFocus?.(path));
  const following = onRowFocus !== undefined;
  const tick = useSteadyCallback((args: { path: string; done: boolean }) => ticks?.onToggle(args));
  const choose = useSteadyCallback((path: string, how: { readonly shift: boolean }) => {
    if (how.shift) selection?.onToggle(path, { order: order() });
    else selection?.onToggle(path);
  });
  const ticked = ticks !== undefined;
  const choosing = selection !== undefined;
  return useMemo(
    () => ({
      shown,
      kinds,
      labels,
      properties,
      colors,
      ranksPriority,
      onOpenNote: open,
      onOpenRow: openRow,
      editor,
      onTick: ticked ? tick : undefined,
      onChoose: choosing ? choose : undefined,
      onFocusRow: following ? focusRow : undefined,
    }),
    [
      shown,
      kinds,
      labels,
      properties,
      colors,
      ranksPriority,
      open,
      openRow,
      editor,
      tick,
      choose,
      ticked,
      choosing,
      focusRow,
      following,
    ],
  );
}

/**
 * The table: its heading row, then the rows, flat or under their groups'
 * header rows. It says how many rows it has, since only those near the
 * window are in the page.
 */
function TableGrid({
  head,
  rows,
  lines,
  look,
  editing,
  noun,
  scroller,
  ticks,
  selection,
  grouping,
}: {
  head: ReactNode;
  rows: readonly BoardRow[];
  /** The lines `useGroupLines` worked out, while the table groups. */
  lines: readonly GroupLine[];
  look: RowLook;
  /** The cell being edited, handed to the one row it is in. */
  editing: CellEditing | null;
  noun: string;
  scroller: HTMLElement | null;
  ticks?: DoneTicks;
  selection?: RowSelection;
  grouping?: TableGrouping;
}) {
  // Each row is told whether it is done and chosen, rather than handed the
  // sets: a tick or a choice then draws the one row it changed.
  const row = (found: BoardRow, place: LinePlace) => (
    <TableRow
      key={found.path}
      path={found.path}
      values={found.values}
      look={look}
      done={ticks?.isDone(found.values) === true}
      chosen={selection?.selected.has(found.path) === true}
      editing={editing?.path === found.path ? editing : null}
      index={place.index}
      measure={place.measure}
    />
  );
  const lead = leadCellCount(look);
  return (
    <table
      className={grouping !== undefined ? 'table__grid table__grid--grouped' : 'table__grid'}
      aria-rowcount={(grouping !== undefined ? lines.length : rows.length) + 1}
    >
      {head}
      {grouping !== undefined ? (
        <GroupedRows
          grouping={grouping}
          lines={lines}
          columns={look.shown.map((key) => ({ key, kind: look.kinds[key] }))}
          lead={lead}
          noun={noun}
          newLabel={newNoteLabel(noun)}
          renderRow={row}
          scroller={scroller}
        />
      ) : (
        <FlatRows
          rows={rows}
          width={lead + look.shown.length}
          renderRow={row}
          scroller={scroller}
        />
      )}
      <tfoot>
        {/* Room under the last row, so it scrolls clear of the window's foot. */}
        <tr className="table__room" aria-hidden="true">
          <td colSpan={lead + look.shown.length} />
        </tr>
      </tfoot>
    </table>
  );
}

function TableHead({
  columns,
  sorts,
  schema,
  onToggleSort,
  ticked,
  choose,
}: {
  columns: readonly string[];
  sorts: readonly QuerySort[];
  schema: TableSchema;
  onToggleSort: (column: string) => void;
  /** Rows lead with a done box, which needs a heading cell of its own. */
  ticked: boolean;
  /** The box that chooses every row, while rows can be chosen. */
  choose: ReactNode;
}) {
  return (
    <thead>
      <tr>
        {choose !== null && <th className="table__choose">{choose}</th>}
        {ticked && (
          <th className="table__done">
            <span className="visually-hidden">Done</span>
          </th>
        )}
        {columns.map((column) => {
          const sort = sorts.find((candidate) => candidate.key === column);
          const label = columnLabel(column, schema);
          // ARIA allows one aria-sort per table: the primary sort's heading carries it.
          const primary = sort !== undefined && sort === sorts[0];
          return (
            <th
              key={column}
              className={column === TITLE ? 'table__name-head' : undefined}
              aria-sort={
                !primary || sort === undefined
                  ? undefined
                  : sort.direction === 'asc'
                    ? 'ascending'
                    : 'descending'
              }
            >
              <button
                type="button"
                className={
                  sort === undefined ? 'table__heading' : 'table__heading table__heading--sorted'
                }
                onClick={() => onToggleSort(column)}
                title={`Sort by ${label}`}
              >
                {label}
                {sort !== undefined && (
                  <Icon
                    name="up"
                    size={11}
                    className={
                      sort.direction === 'desc' ? 'table__sort table__sort--desc' : 'table__sort'
                    }
                  />
                )}
              </button>
            </th>
          );
        })}
      </tr>
    </thead>
  );
}
