import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  rowToFocusAfter,
  type BoardRow,
  type GtdStatus,
  type TaskRowFacts,
  type VaultPath,
} from '@dfai/domain';
import { CONTROLS, useRowHandles } from '../row-handles.ts';
import { heldWhile, MoveMenu, todayToggle } from '../task-row-commands.tsx';

/** What one task row's controls draw (#107): the task's facts, and where its last change stands. */
export interface TaskRowShown extends TaskRowFacts {
  /** Its last change has yet to be read back, so it takes no other until then. */
  readonly waits: boolean;
  /** Why its last change was not made, with that change to try again; null when nothing was refused. */
  readonly refusal: { readonly message: string; readonly onRetry: () => void } | null;
}

/**
 * What a query's result needs to let its task rows be acted on (#107): each
 * row's controls, and what pressing them asks for. Given only for a query
 * of tasks in a view; without it — a query block in a note — rows are look-only.
 */
export interface TaskRowControls {
  /** The row's controls; undefined for a row that is not a task the view can act on. */
  readonly of: (row: BoardRow) => TaskRowShown | undefined;
  readonly onDone: (row: BoardRow, done: boolean) => void;
  readonly onMove: (row: BoardRow, status: GtdStatus) => void;
  /** Toggles its choice for today: `chosen` is whether it is chosen now. */
  readonly onToday: (row: BoardRow, chosen: boolean) => void;
}

/** Where the focus is among a result's task rows, by row (#107), as on the Today page. */
export interface TaskRowFocus {
  /** A row's handle: its done box, where the focus lands when the row is focused. */
  readonly rowRef: (path: VaultPath) => (element: HTMLElement | null) => void;
  /** Says the focus is on one of a row's controls. */
  readonly onFocusRow: (path: VaultPath) => void;
}

/**
 * Keeps the focus among a result's task rows (#107): when the row a control
 * of which had the focus leaves the result — ticked out of Next actions, say
 * — the focus goes to the row under it, or the one above when it was last
 * (`rowToFocusAfter`), as on Today; never to the top of the page. Left alone
 * when the person has put the focus on another control since.
 */
export function useTaskRowFocus(rows: readonly BoardRow[]): TaskRowFocus {
  // A row's path is a vault path as the index answers it.
  const order = useMemo(() => rows.map((row) => row.path as VaultPath), [rows]);
  const { rowRef, focusRow } = useRowHandles(order);
  const focused = useRef<VaultPath | null>(null);
  const before = useRef(order);
  useEffect(() => {
    const was = before.current;
    before.current = order;
    const left = focused.current;
    if (left === null || order.includes(left)) return;
    focused.current = null;
    if (document.activeElement?.matches(CONTROLS) === true) return;
    const staying = was.filter((path) => path === left || order.includes(path));
    const next = rowToFocusAfter({ order: staying, acted: left });
    if (next !== null) focusRow(next);
  }, [order, focusRow]);
  const onFocusRow = useCallback((path: VaultPath) => {
    focused.current = path;
  }, []);
  return useMemo(() => ({ rowRef, onFocusRow }), [rowRef, onFocusRow]);
}

interface RowControlsGiven {
  readonly row: BoardRow;
  readonly shown: TaskRowShown;
  readonly controls: TaskRowControls;
  readonly focus: TaskRowFocus;
}

const pathOf = (row: BoardRow) => row.path as VaultPath;

/**
 * A task row's done box: a real checkbox, so Space ticks it and a screen
 * reader says what it does. Elements, not components, here and below: each
 * component a row holds is a render the work budgets count.
 */
export function taskDoneBox({ row, shown, controls, focus }: RowControlsGiven) {
  return (
    <input
      ref={focus.rowRef(pathOf(row))}
      onFocus={() => focus.onFocusRow(pathOf(row))}
      type="checkbox"
      className="done-check"
      aria-label={`Mark ${row.title} done`}
      checked={shown.done}
      // Held, not disabled, while its change is written: the focus stays on it (#107).
      {...heldWhile(shown.waits, true)}
      onChange={() => {
        if (!shown.waits) controls.onDone(row, !shown.done);
      }}
      // A press on the box is a tick, never the start of a drag or an open.
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}

/** A task row's Today toggle, where the task can be chosen, and its Move to… menu. */
export function taskCommands({ row, shown, controls, focus }: RowControlsGiven) {
  const { chosen } = shown;
  return (
    <span className="qresult__commands" onFocus={() => focus.onFocusRow(pathOf(row))}>
      {chosen !== null &&
        todayToggle({
          title: row.title,
          chosen,
          disabled: shown.waits,
          holdFocus: true,
          onToggle: () => controls.onToday(row, chosen),
        })}
      <MoveMenu
        title={row.title}
        statuses={shown.moves}
        busy={shown.waits}
        holdFocus
        onMove={(status) => controls.onMove(row, status)}
      />
    </span>
  );
}

/** Why the row's last change was refused, said on the row, with that change to try again. */
export function taskRefusal({ row, shown }: Pick<RowControlsGiven, 'row' | 'shown'>) {
  const { refusal } = shown;
  if (refusal === null) return null;
  return (
    <span className="qresult__refusal" role="alert">
      {refusal.message}{' '}
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-label={`Try again: ${row.title}`}
        onClick={refusal.onRetry}
      >
        Try again
      </button>
    </span>
  );
}
