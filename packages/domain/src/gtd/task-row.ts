import { RECURRENCE_KEY } from '../query/repeating-task.ts';
import { taskAsRead, type TaskAsRead } from '../today/row-read.ts';
import {
  FINISHED_TASK_STATUS,
  GTD_STATUSES,
  TASK_KEYS,
  TASK_TYPE,
  type GtdStatus,
} from './gtd-status.ts';

/** A property's one value as text: null when it has none, or holds a list of several. */
export const singleTextSql = (key: string, column: string) =>
  `(SELECT CASE WHEN count(*) = 1 THEN max(p.value_text) END FROM props AS p WHERE p.path = ${column} AND p.key = '${key}')`;

/** A date property's first day, `YYYY-MM-DD`; null when it holds no date. */
export const firstDaySql = (key: string, column: string) =>
  `(SELECT substr(p.value_date, 1, 10) FROM props AS p WHERE p.path = ${column} AND p.key = '${key}' AND p.value_date IS NOT NULL ORDER BY p.idx LIMIT 1)`;

/**
 * 1 when a property holds something other than one day — words, a number, a
 * list of several — as `focusIsOwn` reads the file; 0 for none, a blank, or one day.
 */
export const notOneDaySql = (key: string, column: string) =>
  `(SELECT CASE WHEN count(*) = 0 OR (count(*) = 1 AND max(p.value_date) IS NOT NULL) THEN 0 ELSE 1 END FROM props AS p WHERE p.path = ${column} AND p.key = '${key}' AND coalesce(p.value_text, p.value_json, '') <> '')`;

/**
 * The columns a query's task rows carry besides what they show (#107), named
 * so no field of a type can be called the same: what a row's done box,
 * status menu and Today toggle read, and what a change to it is judged
 * against — read from the index as the Today page reads it.
 */
export const TASK_ROW_COLUMNS = {
  status: 'task:status',
  due: 'task:due',
  defer: 'task:defer',
  focus: 'task:focus',
  focusIsOwn: 'task:focusIsOwn',
  recurrence: 'task:recurrence',
} as const;

/** The hidden task columns as SQL, for the note whose path is at `column`. */
export function taskRowColumnsSql(column: string): readonly string[] {
  const named = (value: string, alias: string) => `${value} AS "${alias}"`;
  return [
    named(singleTextSql(TASK_KEYS.status, column), TASK_ROW_COLUMNS.status),
    named(firstDaySql(TASK_KEYS.due, column), TASK_ROW_COLUMNS.due),
    named(firstDaySql(TASK_KEYS.defer, column), TASK_ROW_COLUMNS.defer),
    named(firstDaySql(TASK_KEYS.focus, column), TASK_ROW_COLUMNS.focus),
    named(notOneDaySql(TASK_KEYS.focus, column), TASK_ROW_COLUMNS.focusIsOwn),
    named(singleTextSql(RECURRENCE_KEY, column), TASK_ROW_COLUMNS.recurrence),
  ];
}

/** Whether a query lists tasks alone — `FROM task` — whose rows can then be acted on. */
export const listsTasksAlone = (from: readonly string[]) =>
  from.length === 1 && from[0]?.trim().toLowerCase() === TASK_TYPE;

/** A task as a query row read it: what its controls show, and what a change is judged against. */
export interface TaskRowState {
  readonly asRead: TaskAsRead;
  /** Whether its `focus` is the person's own rather than a day (#108): no choice writes over it. */
  readonly focusIsOwn: boolean;
  /** Its `recurrence` as written, so a tick can be drawn where its roll puts it; null for none. */
  readonly recurrence: string | null;
}

const textOrNull = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);

/** A row's task, from the hidden columns it carries; null for a row that carries none. */
export function taskRowState(values: Readonly<Record<string, unknown>>): TaskRowState | null {
  if (!Object.hasOwn(values, TASK_ROW_COLUMNS.status)) return null;
  return {
    asRead: taskAsRead({
      [TASK_KEYS.status]: values[TASK_ROW_COLUMNS.status],
      [TASK_KEYS.due]: textOrNull(values[TASK_ROW_COLUMNS.due]),
      [TASK_KEYS.defer]: textOrNull(values[TASK_ROW_COLUMNS.defer]),
      [TASK_KEYS.focus]: textOrNull(values[TASK_ROW_COLUMNS.focus]),
    }),
    focusIsOwn: Number(values[TASK_ROW_COLUMNS.focusIsOwn]) === 1,
    recurrence: textOrNull(values[TASK_ROW_COLUMNS.recurrence]),
  };
}

/**
 * The row's values with a change to its task laid over them: each changed
 * key under its own name, as a shown column holds it, and in the hidden
 * task column that carries it, so the row's controls read it too.
 */
export function taskRowWithChanges(
  values: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const laid: Record<string, unknown> = { ...values };
  const hidden: Readonly<Record<string, string>> = {
    [TASK_KEYS.status]: TASK_ROW_COLUMNS.status,
    [TASK_KEYS.due]: TASK_ROW_COLUMNS.due,
    [TASK_KEYS.defer]: TASK_ROW_COLUMNS.defer,
    [TASK_KEYS.focus]: TASK_ROW_COLUMNS.focus,
    [RECURRENCE_KEY]: TASK_ROW_COLUMNS.recurrence,
  };
  for (const [key, value] of Object.entries(changes)) {
    const shown = value ?? null;
    if (Object.hasOwn(values, key)) laid[key] = shown;
    const column = hidden[key];
    if (column !== undefined) laid[column] = shown;
  }
  return laid;
}

/** What a task row's controls show (#107). */
export interface TaskRowFacts {
  /** Whether its done box is ticked: the task is finished (Archive). */
  readonly done: boolean;
  /** The statuses its menu offers: every one of GTD's eight but its own. */
  readonly moves: readonly GtdStatus[];
  /**
   * Whether it is chosen for today, which its Today toggle shows; null where
   * there is no toggle — the vault does not choose, or its `focus` is the person's own.
   */
  readonly chosen: boolean | null;
}

/** The controls of a task row, as the task reads. */
export function taskRowFacts({
  state,
  today,
  choosing,
}: {
  state: TaskRowState;
  /** `YYYY-MM-DD`, from the injected clock. */
  today: string;
  /** Whether the vault's Task type keeps a Chosen for date (`choosesForToday`). */
  choosing: boolean;
}): TaskRowFacts {
  const { status, focus } = state.asRead;
  return {
    done: status === FINISHED_TASK_STATUS,
    moves: GTD_STATUSES.filter((offered) => offered !== status),
    chosen: !choosing || state.focusIsOwn ? null : focus === today,
  };
}
