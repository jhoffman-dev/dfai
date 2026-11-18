import { isBlankValue, TASK_KEYS } from './gtd-status.ts';
import type { PropertyDef } from '../types/property-def.ts';

/**
 * How urgent a task is (#913, ADR-0029's addendum): 1 is the most urgent, 4
 * the least, as Todoist numbers them for the person. No priority is the key
 * left out, never a fifth value.
 */
export const TASK_PRIORITIES = [1, 2, 3, 4] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** `priority`, a number, as the built-in Task type declares it. */
export const PRIORITY_PROPERTY: PropertyDef = {
  key: TASK_KEYS.priority,
  kind: 'number',
  label: 'Priority',
  required: false,
  options: [],
  target: null,
  many: false,
};

/** Whether a value is a priority exactly as one is written: the integer 1, 2, 3 or 4. */
export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'number' && (TASK_PRIORITIES as readonly number[]).includes(value);
}

const PRIORITY_TEXT = /^[1-4]$/;

/**
 * The priority a value holds as it is read back — the number, or its digit
 * as text, which is how the index and a typed field hand it over — or null
 * for none, or for anything that is not one of the four.
 */
export function taskPriorityOf(value: unknown): TaskPriority | null {
  if (isTaskPriority(value)) return value;
  if (typeof value !== 'string' || !PRIORITY_TEXT.test(value.trim())) return null;
  return Number(value.trim()) as TaskPriority;
}

/** "P1" to "P4": what a pill says. */
export const priorityLabel = (priority: TaskPriority): string => `P${priority}`;

/** "Priority 1": what a pill is called for a screen reader, which "P1" alone does not say. */
export const priorityName = (priority: TaskPriority): string => `Priority ${priority}`;

/**
 * Orders tasks by priority, the most urgent first and those with none last,
 * as a sort ascending lists them. Ties are 0, for the caller's next key.
 */
export function comparePriority(left: TaskPriority | null, right: TaskPriority | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

/** What a change to `priority` comes to: the value to write (null takes the key out), or why not. */
export type PriorityChange = { readonly value: TaskPriority | null } | { readonly refused: string };

/**
 * A priority as a change writes it (the task rules, ADR-0029): one of the
 * four, its digit as text written as the number, and a blank as none, which
 * takes the key out so the note is as it was before it had one. Anything
 * else is refused.
 */
export function priorityChange(value: unknown): PriorityChange {
  if (value === null || value === undefined || isBlankValue(value)) return { value: null };
  const priority = taskPriorityOf(value);
  if (priority !== null) return { value: priority };
  return {
    refused: `A task’s priority is 1 (the most urgent) to 4, or none: not ${shown(value)}.`,
  };
}

/** How much of a refused value is said back: what was sent may be any length. */
const SHOWN_LENGTH = 40;

function shown(value: unknown): string {
  const text = typeof value === 'string' ? `“${value}”` : (JSON.stringify(value) ?? String(value));
  return text.length > SHOWN_LENGTH ? `${text.slice(0, SHOWN_LENGTH)}…` : text;
}
