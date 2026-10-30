import { useId } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { durationLabel, type TaskSchedule, type TrayTask } from '@dfai/domain';
import { planWords } from './drag/announcements.ts';
import { trayDragId } from './drag/tray-drag.ts';

/** A task let go on the calendar: on empty time, which makes a block, or on a block. */
export type PlanDrop =
  | {
      readonly kind: 'time';
      readonly task: TrayTask;
      readonly date: string;
      /** After midnight, on the quarter hour. */
      readonly minutes: number;
    }
  | { readonly kind: 'block'; readonly task: TrayTask; readonly block: string };

/**
 * Planning the day on a calendar of blocks (P31-02): the next actions to drag
 * into time, what to do with one let go there, and the last drop to take back.
 */
export interface Planner {
  /** The tray's tasks, in the order it lists them; null while they are read. */
  readonly tasks: readonly TrayTask[] | null;
  /** Why the tray could not be read, or why the last drop or undo failed. */
  readonly problem: string | null;
  readonly place: (drop: PlanDrop) => void;
  /** What the last drop did, offered to be taken back; null when there is nothing to. */
  readonly undo: { readonly said: string; readonly run: () => void } | null;
}

/** "1h of 2h scheduled", or the time alone when the task has no estimate. */
function scheduleLine(schedule: TaskSchedule | null): string {
  if (schedule === null) return '';
  const { estimate, scheduled } = schedule;
  if (estimate === null) {
    return scheduled === 0 ? 'No estimate' : `${durationLabel(scheduled)} scheduled, no estimate`;
  }
  return `${durationLabel(scheduled)} of ${durationLabel(estimate)} scheduled`;
}

/**
 * The tasks chosen for today, then the next actions, beside the week's
 * clock, the ones with no time yet first in each.
 * Drag one onto empty time to make a block for it, sized to what it still
 * needs, or onto a block to add it there; drag it again to split it across
 * another block. From the keyboard, or with a click, a task is chosen here and
 * then placed with Enter on an hour or a block of the clock.
 */
export function ScheduleTray({
  planner,
  choosing,
  onChoose,
}: {
  planner: Planner;
  /** The task chosen to be placed with the keyboard or a click, or null. */
  choosing: TrayTask | null;
  onChoose: (task: TrayTask | null) => void;
}) {
  const instructions = useId();
  const { tasks, problem, undo } = planner;
  return (
    <aside className="plan-tray" aria-label="Next actions to plan">
      <h2 className="plan-tray__heading">Next actions</h2>
      <p id={instructions} className="visually-hidden">
        {planWords.instructions}
      </p>
      {problem !== null && (
        <p className="plan-tray__problem" role="alert">
          {problem}
        </p>
      )}
      <p className="plan-tray__status" role="status">
        {choosing !== null ? planWords.choosing(choosing.title) : (undo?.said ?? '')}
        {choosing === null && undo !== null && (
          <button type="button" className="plan-tray__undo" onClick={undo.run}>
            Undo
          </button>
        )}
      </p>
      {tasks === null ? null : tasks.length === 0 ? (
        <p className="plan-tray__empty">Nothing is waiting as a next action.</p>
      ) : (
        <ul className="plan-tray__list">
          {tasks.map((task) => (
            <TrayItem
              key={task.path}
              task={task}
              chosen={choosing?.path === task.path}
              describedBy={instructions}
              onChoose={onChoose}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

/**
 * A task in the tray: dragged by the pointer from anywhere on it; chosen, to
 * be placed by the keyboard or a click, with its button. The drag takes the
 * pointer only — its keyboard drag would have nowhere on the clock to step to.
 */
function TrayItem({
  task,
  chosen,
  describedBy,
  onChoose,
}: {
  task: TrayTask;
  chosen: boolean;
  describedBy: string;
  onChoose: (task: TrayTask | null) => void;
}) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: trayDragId(task) });
  const line = scheduleLine(task.schedule);
  const classes = ['plan-tray__task'];
  if (isDragging) classes.push('plan-tray__task--held');
  return (
    <li
      ref={setNodeRef}
      className={classes.join(' ')}
      data-path={task.path}
      {...listeners}
      // The pointer's half of the drag alone: Enter and Space are the button's.
      onKeyDown={undefined}
    >
      <button
        type="button"
        aria-pressed={chosen}
        aria-describedby={describedBy}
        onClick={() => onChoose(chosen ? null : task)}
      >
        <span className="plan-tray__title">{task.title}</span>
        {task.chosen && <span className="plan-tray__chosen">Chosen for today</span>}
        {line !== '' && <span className="plan-tray__schedule">{line}</span>}
      </button>
    </li>
  );
}

/** The task under the pointer while it is dragged: a picture, hidden from assistive technology. */
export function LiftedTrayTask({ task }: { task: TrayTask }) {
  return (
    <div className="plan-tray__task plan-tray__task--lifted" aria-hidden="true">
      <span className="plan-tray__title">{task.title}</span>
    </div>
  );
}
