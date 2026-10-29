import type { BoardRow, GtdStatus, TaskRowFacts } from '@dfai/domain';
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

interface RowControlsGiven {
  readonly row: BoardRow;
  readonly shown: TaskRowShown;
  readonly controls: TaskRowControls;
}

/**
 * A task row's done box: a real checkbox, so Space ticks it and a screen
 * reader says what it does. Elements, not components, here and below: each
 * component a row holds is a render the work budgets count.
 */
export function taskDoneBox({ row, shown, controls }: RowControlsGiven) {
  return (
    <input
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
export function taskCommands({ row, shown, controls }: RowControlsGiven) {
  const { chosen } = shown;
  return (
    <span className="qresult__commands">
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
