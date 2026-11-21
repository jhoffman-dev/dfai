import { isBlankValue, TASK_KEYS, TASK_TYPE } from './gtd-status.ts';
import type { ObjectType, PropertyDef } from '../types/property-def.ts';

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

/** What a change to `priority` comes to: the value to write (null takes the key out), or why not. */
export type PriorityChange = { readonly value: TaskPriority | null } | { readonly refused: string };

/** Why a value is no priority: said without echoing it, which may be anything at all. */
export const PRIORITY_REFUSAL =
  'A task’s priority is a whole number from 1 (the most urgent) to 4, or none.';

/**
 * A priority as a change writes it (the task rules, ADR-0029): one of the
 * four, its digit as text written as the number, and a blank as none, which
 * takes the key out so the note is as it was before it had one. Anything
 * else is refused.
 */
export function priorityChange(value: unknown): PriorityChange {
  if (value === null || value === undefined || isBlankValue(value)) return { value: null };
  const priority = taskPriorityOf(value);
  return priority === null ? { refused: PRIORITY_REFUSAL } : { value: priority };
}

const declaredPriority = (type: ObjectType | null) =>
  type?.properties.find((property) => property.key === TASK_KEYS.priority);

/**
 * Whether a vault's Task type keeps priority as this feature does (#913): as
 * a number, or not declaring it at all — as a vault with no Task type yet,
 * which is given the built-in one, does not. A type that declares
 * `priority` as anything else keeps a priority of its own, High to Low, say:
 * then no rule, no pill and no P1–P4 picker touch it.
 */
export function keepsTaskPriority(taskType: ObjectType | null): boolean {
  const declared = declaredPriority(taskType);
  return declared === undefined || declared.kind === 'number';
}

/**
 * Whether a property is a task's 1-to-4 priority, which is picked and drawn
 * as one: `priority`, declared a number, on the Task type. A goal's own
 * number `priority`, ranked 1 to 10, is a number like any other.
 */
export function isTaskPriorityField({
  typeName,
  def,
}: {
  typeName: string | null;
  def: Pick<PropertyDef, 'key' | 'kind'>;
}): boolean {
  return (
    typeName?.trim().toLowerCase() === TASK_TYPE &&
    def.key === TASK_KEYS.priority &&
    def.kind === 'number'
  );
}
