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

/** A choice of a priority field, valued as a `<select>` holds it. */
export interface PriorityChoice {
  readonly value: string;
  readonly label: string;
}

/** The choice that stands for a value of the note's own — `7`, `high` — kept until another is picked. */
const OTHER = 'other';

const CHOICES: readonly PriorityChoice[] = [
  { value: '', label: 'No priority' },
  ...TASK_PRIORITIES.map((priority) => ({
    value: String(priority),
    label: priorityLabel(priority),
  })),
];

/**
 * What a priority field shows for what the note holds: none, P1 to P4, or —
 * for any other value, which a soft field keeps as written — "Other: 7",
 * chosen, so the field says what the file says and changes nothing until
 * the person picks.
 */
export function priorityPicker(value: unknown): {
  readonly selected: string;
  readonly choices: readonly PriorityChoice[];
} {
  const priority = taskPriorityOf(value);
  if (priority !== null) return { selected: String(priority), choices: CHOICES };
  const written = shownValue(value);
  if (written === '') return { selected: '', choices: CHOICES };
  return { selected: OTHER, choices: [...CHOICES, { value: OTHER, label: `Other: ${written}` }] };
}

/** How long a value of the note's own is shown in "Other: …" before it is cut short. */
const SHOWN_LENGTH = 24;

/** A value of the note's own as "Other: …" shows it: words as written, anything else as compact JSON, cut short. */
function shownValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value.trim() : (JSON.stringify(value) ?? String(value));
  return text.length > SHOWN_LENGTH ? `${text.slice(0, SHOWN_LENGTH - 1)}…` : text;
}

/**
 * What a priority field's choice writes: the number, null to take the key
 * out, or undefined for "Other", which leaves the note's own value as it is.
 */
export function priorityFromChoice(choice: string): TaskPriority | null | undefined {
  return choice === OTHER ? undefined : taskPriorityOf(choice);
}

/** How a field holding a priority is painted: its pill's hue, or the empty pill for none. */
export function priorityPaint(value: unknown): PillPaint {
  const priority = taskPriorityOf(value);
  return pillPaint(priority === null ? null : PRIORITY_HUES[priority]);
}
