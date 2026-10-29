import { memo, useRef } from 'react';
import {
  heldOptions,
  holdsLinks,
  isYou,
  optionColor,
  optionColorsOf,
  propertyRole,
  type OptionColors,
  type PropertyDef,
  type PropertyKind,
} from '@dfai/domain';
import type { CellEditing, CellEditorHooks } from './cells/cell-editing.ts';
import { useAnchoring, usePressOnOpenCell, useReturningFocus } from './cells/cell-focus.ts';
import { CellInput } from './cells/cell-input.tsx';
import { picksFrom } from './cells/cell-pickers.tsx';
import type { CellAt } from './cells/cell-keys.ts';
import { CheckboxCell } from './cells/checkbox-cell.tsx';
import { DateCellEditor } from './cells/date-cell.tsx';
import { NumberCellEditor } from './cells/number-cell.tsx';
import { RelationCell } from './cells/relation-cell.tsx';
import { ChecklistProgress } from './checklist-progress.tsx';
import { DoneCheckbox, type DoneTicks } from './done-checkbox.tsx';
import { ariaRowIndex, type LinePlace } from './grouped-rows.tsx';
import { ROW_STOP } from './row-focus.ts';
import { Icon } from './icon.tsx';
import { openHowFrom, type OpenHow } from './open-how.ts';
import { SelectBox } from './row-selection.tsx';
import { sameEntries } from './steady-value.ts';
import { StatusPill, TintedPill } from './status-pill.tsx';

export type { CellEdit, CellValue } from './cells/cell-editing.ts';

/** The column every row is named by. */
export const TITLE = 'title';

/**
 * What every row of one table shares: its columns, and what can be done to a
 * row. Held steady from one render to the next, so a row draws again only
 * for a change of its own (#238).
 */
export interface RowLook {
  readonly shown: readonly string[];
  readonly kinds: Readonly<Record<string, PropertyKind>>;
  /** The declared label of each property, which names a box or a picker. */
  readonly labels: Readonly<Record<string, string>>;
  /** The declared property under each key, for the editor it opens. */
  readonly properties: Readonly<Record<string, PropertyDef>>;
  /** The colours the type chose for each select's options, which its pills are drawn in. */
  readonly colors: Readonly<Record<string, OptionColors>>;
  /** Opens a note a cell links: a relation's value. */
  readonly onOpenNote: (path: string, how?: OpenHow) => void;
  /** A row's name clicked: peeks or opens its note, as the click and the table say. */
  readonly onOpenRow: (path: string, how: OpenHow) => void;
  /** Given while cells edit in place; left out, the cells are read only. */
  readonly editor?: CellEditorHooks | undefined;
  /** Given when the view's type can be ticked done: each row leads with a box. */
  readonly onTick?: DoneTicks['onToggle'] | undefined;
  /**
   * Given while rows can be chosen: each row leads with a box that toggles it,
   * or, with Shift held, extends the choice to it.
   */
  readonly onChoose?: ((path: string, how: { readonly shift: boolean }) => void) | undefined;
  /**
   * Given when something follows the focused row — the right sidebar's
   * Properties: told as the focus lands anywhere in a row. Steady, as the
   * rest of the look is, so a row is not drawn again for it.
   */
  readonly onFocusRow?: ((path: string) => void) | undefined;
}

/** The cells a row leads with before its name: a box to choose it, a box to tick it done. */
export function leadCellCount(look: RowLook): number {
  return (look.onChoose === undefined ? 0 : 1) + (look.onTick === undefined ? 0 : 1);
}

/**
 * The columns of a table whose cells Tab walks: every shown column but the
 * name, which opens the note, and a relation the type says nothing about,
 * whose cell has no picker to open (the app's schema before slice 5b).
 */
export function editableColumns({
  shown,
  kinds,
  properties,
}: Pick<RowLook, 'shown' | 'kinds' | 'properties'>): string[] {
  return shown.filter(
    (column) => column !== TITLE && (kinds[column] !== 'relation' || picksFrom(properties[column])),
  );
}

/** One row as the table hands it over: the note, and what it says of the row. */
export interface TableRowProps {
  readonly path: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly look: RowLook;
  /** Whether the note counts as finished, where rows can be ticked. */
  readonly done: boolean;
  /** Whether the row is chosen, while rows can be. */
  readonly chosen: boolean;
  /** The cell of this row being edited, or null while none is. */
  readonly editing: CellEditing | null;
  /** Where the row sits among the lines a virtualised table measures. */
  readonly index?: number;
  /** The virtualiser's ref, which measures the row as drawn. */
  readonly measure?: LinePlace['measure'];
}

/**
 * One note as a table row: its boxes, then a cell per shown column. Drawn
 * again only when what it shows changes — a query read again hands every row
 * new values, and only the row whose values differ is drawn (#238).
 */
export const TableRow = memo(function TableRow({
  path,
  values,
  look,
  done,
  chosen,
  editing,
  index,
  measure,
}: TableRowProps) {
  const { onChoose, onTick, onOpenNote, onOpenRow, editor, onFocusRow } = look;
  const title = String(values[TITLE] ?? path);
  return (
    <tr
      className={done ? 'table__row table__row--done' : 'table__row'}
      ref={measure}
      data-index={index}
      aria-rowindex={index === undefined ? undefined : ariaRowIndex(index)}
      // Focus bubbles in React: a cell's box, button or editor taking it says which row.
      {...(onFocusRow !== undefined && { onFocus: () => onFocusRow(path) })}
    >
      {onChoose !== undefined && (
        <td className="table__choose">
          <SelectBox
            label={`Select ${title}`}
            checked={chosen}
            onChange={(_checked, how) => onChoose(path, how)}
          />
        </td>
      )}
      {onTick !== undefined && (
        <td className="table__done">
          <DoneCheckbox
            path={path}
            title={String(values[TITLE] ?? '')}
            values={values}
            ticks={{ isDone: () => done, onToggle: onTick }}
          />
        </td>
      )}
      {look.shown.map((column) => (
        <td
          key={column}
          className={column === TITLE ? 'table__name' : undefined}
          data-kind={look.kinds[column]}
        >
          <CellFor
            at={{ path, column }}
            title={title}
            look={look}
            value={values[column]}
            editing={editing?.column === column ? editing : null}
            editor={editor}
            onOpen={(how) => onOpenRow(path, how)}
            onOpenNote={onOpenNote}
          />
          {column === TITLE && <ChecklistProgress values={values} kinds={look.kinds} />}
        </td>
      ))}
    </tr>
  );
}, sameRow);

/** Whether a row would draw the same: its values compared by what they hold, the rest by identity. */
function sameRow(before: TableRowProps, after: TableRowProps): boolean {
  return (
    before.path === after.path &&
    before.look === after.look &&
    before.done === after.done &&
    before.chosen === after.chosen &&
    before.editing === after.editing &&
    before.index === after.index &&
    before.measure === after.measure &&
    (before.values === after.values || sameEntries(before.values, after.values))
  );
}

/**
 * A cell drawn by what it holds: the name opens the note, the rest edit in
 * place — a box ticks, a relation or a status opens its picker, the others
 * open the field their kind calls for.
 */
function CellFor({
  at,
  title,
  look,
  value,
  editing,
  editor,
  onOpen,
  onOpenNote,
}: {
  at: CellAt;
  /** The row's name, which names its boxes for a screen reader. */
  title: string;
  look: RowLook;
  value: unknown;
  /** This cell's edit, while it is the one being edited. */
  editing: CellEditing | null;
  editor: CellEditorHooks | undefined;
  /** Opens the row's note; `how` is where the click asked for it. */
  onOpen: (how: OpenHow) => void;
  /** Opens a note a relation in the row links. */
  onOpenNote: (path: string) => void;
}) {
  const { column } = at;
  if (column === TITLE) {
    return (
      <button
        {...ROW_STOP}
        type="button"
        className="table__link"
        onClick={(event) => {
          // WebKit, which the app runs in, does not focus a clicked button; the
          // peek this opens hands the focus back to what held it as it closes.
          event.currentTarget.focus();
          onOpen(openHowFrom(event));
        }}
      >
        <span className="table__title">{String(value ?? '')}</span>
      </button>
    );
  }
  const kind = look.kinds[column];
  const label = look.labels[column] ?? column;
  // A column no type declares — a SQL view's — is a relation when it holds links.
  if (kind === 'relation' || (kind === undefined && holdsLinks(value))) {
    return (
      <RelationCell
        at={at}
        label={label}
        value={value}
        editing={editing !== null}
        picks={picksFrom(look.properties[column])}
        editor={editor}
        onOpenNote={onOpenNote}
      />
    );
  }
  if (kind === 'checkbox') {
    return (
      <CheckboxCell
        at={at}
        label={`${label} for ${title}`}
        value={value}
        editing={editing !== null}
        editor={editor}
      />
    );
  }
  const face = faceOf({ kind, column, value });
  const text = value === null || value === undefined ? '' : String(value);
  const colors = { key: column, colors: optionColorsOf(look.colors, column) };
  if (editor === undefined) {
    return (
      <span className="table__cell" title={fullValue(text)}>
        {cellFace({ text, value, look: face, colors })}
      </span>
    );
  }
  const picks = picksFrom(look.properties[column]);
  if (editing !== null && !picks) {
    const field = { text, draft: editing.draft, editor };
    if (kind === 'number') return <NumberCellEditor {...field} />;
    if (kind === 'date') return <DateCellEditor {...field} />;
    return <CellInput {...field} />;
  }
  return (
    <Cell
      at={at}
      text={text}
      value={value}
      colors={colors}
      face={face}
      editor={editor}
      picks={picks}
      expanded={picks && editing !== null}
    />
  );
}

/**
 * A cell as it reads, which opens its editor when clicked, or on ↵ or
 * Space: a field in its place, or — for a status — a picker under it, while
 * which it wears the ring. An empty one stays blank (Table.dc.html); its
 * button still says it is an empty value, so a screen reader finds
 * something to fill in.
 */
function Cell({
  at,
  text,
  value,
  colors,
  face,
  editor,
  picks,
  expanded,
}: {
  at: CellAt;
  text: string;
  value: unknown;
  colors: ColumnColors;
  face: CellLook;
  editor: CellEditorHooks;
  /** Whether the cell edits in a picker under it, rather than a field in it. */
  picks: boolean;
  /** Whether this cell's picker is open under it. */
  expanded: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useReturningFocus(at, editor, button);
  useAnchoring(expanded, editor, button);
  const press = usePressOnOpenCell(expanded);
  return (
    <button
      ref={button}
      type="button"
      className="table__cell"
      aria-label={text === '' ? EMPTY_CELL_NAME : undefined}
      {...(picks && { 'aria-haspopup': 'listbox', 'aria-expanded': expanded })}
      data-cell-stop={at.column}
      data-editing={expanded ? '' : undefined}
      title={fullValue(text)}
      onPointerDown={press.onPointerDown}
      onPointerLeave={press.onPointerLeave}
      onPointerCancel={press.onPointerCancel}
      onClick={(event) => {
        if (press.opens(event)) editor.start(at);
      }}
    >
      {cellFace({ text, value, look: face, colors })}
    </button>
  );
}

/** What an empty editable cell's button is called, since it shows nothing. */
export const EMPTY_CELL_NAME = 'Empty value';

/** A cell is cut short at its measure, so its whole value is its title. */
function fullValue(text: string): string | undefined {
  return text === '' ? undefined : text;
}

/** The column's key and the colours its type chose for its options, as `optionColor` reads them. */
interface ColumnColors {
  readonly key: string;
  readonly colors: OptionColors | undefined;
}

/** How a cell's value reads: a choice's pill, several choices' pills, "You", or its words. */
type CellLook = 'pill' | 'pills' | 'you' | 'text';

function faceOf({
  kind,
  column,
  value,
}: {
  kind: PropertyKind | undefined;
  column: string;
  value: unknown;
}): CellLook {
  if (kind === 'select') return 'pill';
  if (kind === 'multiSelect') return 'pills';
  return propertyRole(column) === 'person' && isYou(value) ? 'you' : 'text';
}

/**
 * What a cell shows of its value. A function its cell calls, not a component:
 * a table draws one per cell, and each component a cell holds is a render
 * "Open the 420-row table" is counted by (tools/perf/budgets.json).
 */
function cellFace({
  text,
  value,
  look,
  colors,
}: {
  text: string;
  value: unknown;
  look: CellLook;
  colors: ColumnColors;
}) {
  if (text === '') return null;
  if (look === 'pill') return <StatusPill value={text} tone={optionColor(colors, text)} />;
  if (look === 'pills') {
    return (
      <span className="table__pills">
        {heldOptions(value).map((option, at) => (
          // A list may hold an option twice; each is drawn where it stands.
          <TintedPill key={at} text={option} color={optionColor(colors, option)} />
        ))}
      </span>
    );
  }
  if (look === 'you') {
    return (
      <span className="table__you" aria-label={text}>
        <Icon name="person" size={12} />
        You
      </span>
    );
  }
  return <span className="table__text">{text}</span>;
}
