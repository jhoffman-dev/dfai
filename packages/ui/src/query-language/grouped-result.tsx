import { useState } from 'react';
import {
  withNoteNames,
  type BoardLane,
  type BoardRow,
  type FieldKind,
  type PropertyKind,
  type RowGroup,
  type ViewLayout,
} from '@dfai/domain';
import { BoardLanes, ColumnHeading } from '../board-lanes.tsx';
import { FlatRows } from '../flat-rows.tsx';
import { ariaRowIndex, GroupedRows, useGroupLines, type LinePlace } from '../grouped-rows.tsx';
import { ROW_STOP } from '../row-focus.ts';
import { Icon } from '../icon.tsx';
import { useNoteNames } from '../note-names.tsx';
import { StatusPill } from '../status-pill.tsx';
import {
  taskCommands,
  taskDoneBox,
  taskRefusal,
  type TaskRowControls,
} from './task-row-controls.tsx';

export interface ResultField {
  readonly key: string;
  readonly label: string;
  /** What it holds, so a group header can add up a number column or count ticked boxes. */
  readonly kind?: FieldKind;
}

export interface GroupedResultProps {
  readonly layout: ViewLayout;
  /** The columns after the name, each with its heading. */
  readonly fields: readonly ResultField[];
  readonly rows: readonly BoardRow[];
  /** The groups and their sub-groups; empty when the query does not group. */
  readonly groups: readonly RowGroup[];
  /** A board's swimlanes, when the query groups THEN by a second field. */
  readonly lanes?: readonly BoardLane[];
  /** The groups folded shut, by id. */
  readonly collapsed: ReadonlySet<string>;
  readonly onToggleGroup: (id: string) => void;
  readonly onOpenNote: (path: string) => void;
  /** The task rows' done box, status menu and Today toggle (#107); without them, rows are look-only. */
  readonly tasks?: TaskRowControls | undefined;
}

/**
 * A query's rows as a table, a list or a board, in their groups and
 * sub-groups (P24-03), drawn as a saved view's are (issue #6): a table's
 * groups are header rows with their counts and column summaries, a board's
 * groups are its columns and its sub-groups the swimlanes across them.
 */
export function GroupedResult(props: GroupedResultProps) {
  if (props.rows.length === 0)
    return <p className="table__empty">Nothing matches this query yet.</p>;
  if (props.layout === 'board') return <ResultBoard {...props} />;
  if (props.layout === 'list') return <ResultList {...props} />;
  return <ResultTable {...props} />;
}

function GroupHeading({
  group,
  level,
  collapsed,
  onToggle,
}: {
  group: RowGroup;
  level: 1 | 2;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const count = group.rows.length;
  return (
    <button
      type="button"
      className={`qresult__heading qresult__heading--level-${level}`}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <Icon
        name="chevron"
        size={14}
        className={collapsed ? 'qresult__fold qresult__fold--shut' : 'qresult__fold'}
      />
      {group.tone === null || group.value === null ? (
        <span className="qresult__label">{group.label}</span>
      ) : (
        <StatusPill value={group.value} tone={group.tone} />
      )}
      <span className="qresult__count" aria-label={`${count} ${count === 1 ? 'note' : 'notes'}`}>
        {count}
      </span>
    </button>
  );
}

/** The groups under one heading, or the rows when there are no more levels. */
function Levels({
  groups,
  level,
  shared,
  rows,
}: {
  groups: readonly RowGroup[];
  level: 1 | 2;
  shared: GroupedResultProps;
  rows: (rows: readonly BoardRow[]) => React.ReactNode;
}) {
  return groups.map((group) => {
    const shut = shared.collapsed.has(group.id);
    return (
      <div
        key={group.id}
        className={`qresult__group qresult__group--level-${level}`}
        role="group"
        aria-label={group.label}
      >
        <GroupHeading
          group={group}
          level={level}
          collapsed={shut}
          onToggle={() => shared.onToggleGroup(group.id)}
        />
        {!shut &&
          (group.subgroups.length === 0 ? (
            rows(group.rows)
          ) : (
            <Levels groups={group.subgroups} level={2} shared={shared} rows={rows} />
          ))}
      </div>
    );
  });
}

function ResultTable(props: GroupedResultProps) {
  // State, not a ref: the rows' virtualiser looks for its scroller in a
  // layout effect, which runs before the sheet's ref is set.
  const [sheet, setSheet] = useState<HTMLDivElement | null>(null);
  const names = useNoteNames();
  const grouping = {
    groups: props.groups,
    collapsed: props.collapsed,
    onToggle: props.onToggleGroup,
  };
  const grouped = props.groups.length > 0;
  const lines = useGroupLines(grouped ? grouping : undefined);
  const { tasks } = props;
  const lead = tasks === undefined ? 0 : 1;
  const row = (found: BoardRow, place: LinePlace) => {
    const given = taskControlsOf(tasks, found);
    return (
      <tr
        key={found.path}
        ref={place.measure}
        data-index={place.index}
        aria-rowindex={ariaRowIndex(place.index)}
      >
        {tasks !== undefined && (
          <td className="table__done">{given === null ? null : taskDoneBox(given)}</td>
        )}
        <td>
          <button
            {...ROW_STOP}
            type="button"
            className="qresult__title"
            onClick={() => props.onOpenNote(found.path)}
          >
            {found.title}
          </button>
          {given !== null && taskRefusal(given)}
        </td>
        {props.fields.map((field) => (
          <td key={field.key} className="qresult__cell">
            {withNoteNames(found.values[field.key], names)}
          </td>
        ))}
        {tasks !== undefined && (
          <td className="qresult__cell">{given === null ? null : taskCommands(given)}</td>
        )}
      </tr>
    );
  };
  const trailing = tasks === undefined ? 0 : 1;
  return (
    <div className="table__sheet qresult__sheet" ref={setSheet}>
      <table
        className="table__grid qresult__table"
        aria-rowcount={(grouped ? lines.length : props.rows.length) + 1}
      >
        <thead>
          <tr>
            {tasks !== undefined && (
              <th scope="col" className="table__done">
                <span className="table__heading">Done</span>
              </th>
            )}
            <th scope="col">
              <span className="table__heading">Name</span>
            </th>
            {props.fields.map((field) => (
              <th scope="col" key={field.key}>
                <span className="table__heading">{field.label}</span>
              </th>
            ))}
            {tasks !== undefined && (
              <th scope="col">
                <span className="table__heading">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        {!grouped ? (
          <FlatRows
            rows={props.rows}
            width={lead + 1 + props.fields.length + trailing}
            renderRow={row}
            scroller={sheet}
          />
        ) : (
          <GroupedRows
            grouping={grouping}
            lines={lines}
            columns={[
              { key: 'title' },
              ...props.fields.map((field) => ({
                key: field.key,
                kind: propertyKindOf(field.kind),
              })),
              ...(trailing === 0 ? [] : [{ key: TASK_COMMANDS_COLUMN }]),
            ]}
            lead={lead}
            noun="note"
            newLabel=""
            renderRow={row}
            scroller={sheet}
          />
        )}
      </table>
    </div>
  );
}

/** The column a task row's Today toggle and Move to… stand in: no field, so nothing is added up under it. */
const TASK_COMMANDS_COLUMN = 'task:commands';

/** A field's kind as a property's, for the summaries a header shows; a built-in adds nothing up. */
function propertyKindOf(kind: FieldKind | undefined): PropertyKind | undefined {
  return kind === 'number' || kind === 'checkbox' ? kind : undefined;
}

function ResultList(props: GroupedResultProps) {
  const list = (rows: readonly BoardRow[]) => <RowsList rows={rows} shared={props} />;
  if (props.groups.length === 0) return list(props.rows);
  return (
    <div className="qresult qresult--list">
      <Levels groups={props.groups} level={1} shared={props} rows={list} />
    </div>
  );
}

/** A row's other values, joined, for a list or a card to show under its name. */
function useMeta(fields: readonly ResultField[]) {
  const names = useNoteNames();
  return (row: BoardRow) =>
    fields
      .map((field) => withNoteNames(row.values[field.key], names))
      .filter((value) => value !== '')
      .join(' · ');
}

function RowsList({ rows, shared }: { rows: readonly BoardRow[]; shared: GroupedResultProps }) {
  const meta = useMeta(shared.fields);
  return (
    <ul className="list-view qresult__list" aria-label="Notes">
      {rows.map((row) => {
        const given = taskControlsOf(shared.tasks, row);
        return (
          <li key={row.path} className="list-view__row">
            {given !== null && taskDoneBox(given)}
            <button
              type="button"
              className="list-view__title"
              onClick={() => shared.onOpenNote(row.path)}
            >
              {row.title}
            </button>
            <span className="list-view__summary">{meta(row)}</span>
            {given !== null && taskCommands(given)}
            {given !== null && taskRefusal(given)}
          </li>
        );
      })}
    </ul>
  );
}

function ResultBoard(props: GroupedResultProps) {
  if (props.lanes !== undefined && props.lanes.length > 0) {
    return (
      <BoardLanes
        columns={props.groups}
        lanes={props.lanes}
        folds={{ collapsed: props.collapsed, onToggle: props.onToggleGroup }}
        renderCell={({ rows, label }) => (
          <section className="board__cell" aria-label={label}>
            <Cards rows={rows} shared={props} quiet />
          </section>
        )}
      />
    );
  }
  const columns: readonly RowGroup[] =
    props.groups.length > 0
      ? props.groups
      : [
          {
            id: '/all',
            field: '',
            kind: 'text',
            label: 'All notes',
            value: null,
            tone: null,
            rows: props.rows,
            subgroups: [],
          },
        ];
  return (
    <div className="board qresult__board">
      {columns.map((column) => (
        <section key={column.id} className="board__column" aria-label={column.label}>
          <header className="board__heading">
            <ColumnHeading column={column} />
          </header>
          <Cards rows={column.rows} shared={props} />
        </section>
      ))}
    </div>
  );
}

function Cards({
  rows,
  shared,
  quiet = false,
}: {
  rows: readonly BoardRow[];
  shared: GroupedResultProps;
  /** An empty lane cell says nothing: a row of "Nothing here yet" is noise. */
  quiet?: boolean;
}) {
  const meta = useMeta(shared.fields);
  if (rows.length === 0) return quiet ? null : <p className="board__empty">Nothing here yet</p>;
  return (
    <ul className="board__cards qresult__cards">
      {rows.map((row) => {
        const given = taskControlsOf(shared.tasks, row);
        if (given === null) {
          return (
            <li key={row.path}>
              <button
                type="button"
                className="qresult__card"
                onClick={() => shared.onOpenNote(row.path)}
              >
                <span className="qresult__card-title">{row.title}</span>
                <span className="qresult__card-meta">{meta(row)}</span>
              </button>
            </li>
          );
        }
        // A task's card holds controls of its own, which a button cannot: its name opens it.
        return (
          <li key={row.path} className="qresult__card qresult__card--task">
            <span className="qresult__card-head">
              {taskDoneBox(given)}
              <button
                type="button"
                className="qresult__title qresult__card-title"
                onClick={() => shared.onOpenNote(row.path)}
              >
                {row.title}
              </button>
            </span>
            <span className="qresult__card-meta">{meta(row)}</span>
            {taskCommands(given)}
            {taskRefusal(given)}
          </li>
        );
      })}
    </ul>
  );
}

/** A row's task controls, when the result has them and the row is a task it can act on. */
function taskControlsOf(tasks: TaskRowControls | undefined, row: BoardRow) {
  const shown = tasks?.of(row);
  return tasks === undefined || shown === undefined ? null : { row, shown, controls: tasks };
}
