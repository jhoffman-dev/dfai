import {
  priorityLabel,
  priorityName,
  TASK_PRIORITIES,
  taskPriorityOf,
  type PillHue,
  type TaskPriority,
} from '@dfai/domain';
import type { ReactNode } from 'react';
import { pillPaint, type PillPaint } from './pill-paint.ts';

/**
 * The pastel each priority is drawn in, as Todoist colours them: the most
 * urgent red, then orange and blue, and the least a plain gray. The words
 * "P1" to "P4" say it as well, so colour is never the only signal.
 */
const PRIORITY_HUES: Readonly<Record<TaskPriority, PillHue>> = {
  1: 'red',
  2: 'orange',
  3: 'blue',
  4: 'gray',
};

/**
 * A task's priority as a 20px pill: it shows "P1", and reads "Priority 1"
 * to a screen reader, from inside a row, a cell's button or a list alike.
 * Nothing for a value that is no priority. A function its row calls, not a
 * component: rows are counted by the renders they make
 * (tools/perf/budgets.json), and a task with no priority must cost nothing.
 */
export function priorityPill(value: unknown, key = 'priority'): ReactNode {
  const priority = taskPriorityOf(value);
  if (priority === null) return null;
  const name = priorityName(priority);
  return (
    <span
      key={key}
      className="status-pill priority-pill"
      data-hue={PRIORITY_HUES[priority]}
      title={name}
    >
      <span aria-hidden="true">{priorityLabel(priority)}</span>
      <span className="visually-hidden">{name}</span>
    </span>
  );
}

/**
 * The choices of a priority field: none, then P1 to P4, valued as the digit a
 * `<select>` holds ('' for none).
 */
export const PRIORITY_CHOICES: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: 'No priority' },
  ...TASK_PRIORITIES.map((priority) => ({
    value: String(priority),
    label: priorityLabel(priority),
  })),
];

/** What a priority field's choice writes: the number, or null to take the key out. */
export function priorityFromChoice(choice: string): TaskPriority | null {
  return taskPriorityOf(choice);
}

/** How a field holding a priority is painted: its pill's hue, or the empty pill for none. */
export function priorityPaint(value: unknown): PillPaint {
  const priority = taskPriorityOf(value);
  return pillPaint(priority === null ? null : PRIORITY_HUES[priority]);
}

/** The choice a priority field shows for what the note holds: '' for none. */
export function priorityChoiceOf(value: unknown): string {
  const priority = taskPriorityOf(value);
  return priority === null ? '' : String(priority);
}
