import { toIndexableProperties } from '../index/property-value.ts';

/**
 * Tasks in DFAI follow GTD (ADR-0029): exactly these eight statuses, in the
 * order work moves through them. "Done" is not one of them — a finished task
 * is `archive`, with the day it was finished in `completed`.
 */
export const GTD_STATUSES = [
  'inbox',
  'backlog',
  'next-action',
  'in-progress',
  'waiting',
  'someday',
  'longterm',
  'archive',
] as const;

export type GtdStatus = (typeof GTD_STATUSES)[number];

/** Each status as James writes it. */
export const GTD_STATUS_LABELS: Readonly<Record<GtdStatus, string>> = {
  inbox: 'Inbox',
  backlog: 'Backlog',
  'next-action': 'Next Action',
  'in-progress': 'In Progress',
  waiting: 'Waiting',
  someday: 'Someday',
  longterm: 'Longterm',
  archive: 'Archive',
};

/** Where a new task starts: captured, it waits to be processed. */
export const NEW_TASK_STATUS: GtdStatus = 'inbox';

/** What ticking a task sets: finished work leaves every list in one move. */
export const FINISHED_TASK_STATUS: GtdStatus = 'archive';

/**
 * Where a finished task goes back to when nothing remembers where it was —
 * unticked after a restart, or a repeating one rolled on to its next date:
 * it was something to do, so it is something to do next.
 */
export const REOPENED_TASK_STATUS: GtdStatus = 'next-action';

/** The status of a task waiting on something; who it waits on is optional (#202). */
export const WAITING_STATUS: GtdStatus = 'waiting';

/** The type tasks are notes of. */
export const TASK_TYPE = 'task';

/** The keys the GTD task model reads, as they are written in a task's frontmatter. */
export const TASK_KEYS = {
  status: 'status',
  waitingOn: 'waiting_on',
  contexts: 'contexts',
  defer: 'defer',
  due: 'due',
  completed: 'completed',
  estimate: 'estimate',
  source: 'source',
  /** The day it was chosen to be done on (#108): `YYYY-MM-DD`, or absent when it is not chosen. */
  focus: 'focus',
} as const;

const STATUSES: ReadonlySet<string> = new Set(GTD_STATUSES);

/** Whether a value is one of the eight statuses, exactly as written. */
export function isGtdStatus(value: unknown): value is GtdStatus {
  return typeof value === 'string' && STATUSES.has(value);
}

/**
 * A task property's values as the index reads them — trimmed, one per item
 * of a list, empty ones dropped — so the rules, the migration and the views
 * agree on what a task holds: `waiting `, `[waiting]` and `waiting` are one
 * status to all of them.
 */
export function indexedTexts(value: unknown): string[] {
  return toIndexableProperties(INDEXED, value).flatMap((row) => {
    if (row.json !== null) return [row.json];
    return row.text === null || row.text === '' ? [] : [row.text];
  });
}

const INDEXED = 'value';

/** Whether a task property says nothing: absent, empty, or a list of nothing but empty names. */
export function isBlankValue(value: unknown): boolean {
  return indexedTexts(value).length === 0;
}

/**
 * The one value a property holds as the index reads it, or null: a blank item
 * is no item, and a list of several — nested or not — holds no one value
 * (PR #616). The rule `singleTextSql` holds in the index, so a status, a
 * recurrence, a tick and a row read a property alike.
 */
export function singleTextOf(value: unknown): string | null {
  const [only, ...more] = indexedTexts(value);
  return only !== undefined && more.length === 0 ? only : null;
}

/** The GTD status a value holds as the index reads it — one status, in any of its spellings — or null. */
export function gtdStatusOf(value: unknown): GtdStatus | null {
  const only = singleTextOf(value);
  return only !== null && isGtdStatus(only) ? only : null;
}

/** Whether a value holds `status` as its one value, by the rule of {@link singleTextOf}. */
export function isStatus(value: unknown, status: GtdStatus): boolean {
  return singleTextOf(value) === status;
}

/** Whether a value, as the index reads it, holds `status` among its items. */
export function holdsStatus(value: unknown, status: GtdStatus): boolean {
  return indexedTexts(value).includes(status);
}
