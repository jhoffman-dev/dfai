import {
  FINISHED_TASK_STATUS,
  holdsStatus,
  RECURRENCE_KEY,
  REOPENED_TASK_STATUS,
  TASK_KEYS,
  TASK_TYPE,
  taskRuleChanges,
  type TaskAsRead,
  type TodayChoice,
} from '@dfai/domain';
import { archiveTaskChange } from '../review/review-actions.ts';
import type { PropertyChanges } from '../query/set-property.ts';
import { choiceChange } from './choose-for-today.ts';

/** What a row of tasks can do to one (#107): Today's rows and a query's alike. */
export type TaskRowAction =
  | { readonly kind: 'done' }
  /** Unticked: a finished task taken back to where open work goes; open work is left as it is. */
  | { readonly kind: 'reopen' }
  | { readonly kind: 'move'; readonly status: string }
  | { readonly kind: 'choice'; readonly choice: TodayChoice; readonly today: string };

/**
 * The change a row's action makes to its task — the one rule for Today's
 * rows and a query view's (#107), so the same action writes the same bytes
 * wherever it is made. Ticking finishes the task as dropping it in the done
 * column does, rolling a repeating one on; moving it to Archive is a tick
 * too. The task rules (ADR-0029) are held where the change is written.
 */
export function taskRowChange(action: TaskRowAction): PropertyChanges {
  switch (action.kind) {
    case 'done':
      return archiveTaskChange();
    case 'reopen':
      // Only a finished task is taken back: unticking open work changes nothing.
      return (properties) =>
        holdsStatus(properties[TASK_KEYS.status], FINISHED_TASK_STATUS)
          ? { [TASK_KEYS.status]: REOPENED_TASK_STATUS }
          : {};
    case 'move':
      return action.status === FINISHED_TASK_STATUS
        ? archiveTaskChange()
        : { [TASK_KEYS.status]: action.status };
    case 'choice':
      return choiceChange({ choice: action.choice, today: action.today });
  }
}

/** A task as its row read it, as the properties a change is worked out from. */
export interface TaskRowProperties {
  readonly asRead: TaskAsRead;
  /** Its `focus` is the person's own: left out, so no rule could end it. */
  readonly focusIsOwn: boolean;
  /** `recurrence` as written, null for none; undefined when the row did not read it. */
  readonly recurrence?: string | null | undefined;
}

/**
 * What a change leaves a task as its row read it, before the write lands
 * (#260, #107): the keys it changes, the task rules' own included — or null
 * when that cannot be known before it is written (a rule-shaped change on a
 * row read without its recurrence) or is refused, as the write will refuse it.
 */
export function taskRowAsChanged({
  task,
  values,
  today,
}: {
  task: TaskRowProperties;
  values: PropertyChanges;
  /** `YYYY-MM-DD`, from the injected clock. */
  today: string;
}): Readonly<Record<string, unknown>> | null {
  if (typeof values === 'function' && task.recurrence === undefined) return null;
  const { status, due, defer, focus } = task.asRead;
  const properties = {
    [TASK_KEYS.status]: status,
    [TASK_KEYS.due]: due,
    [TASK_KEYS.defer]: defer,
    ...(!task.focusIsOwn && { [TASK_KEYS.focus]: focus }),
    ...(task.recurrence !== undefined && { [RECURRENCE_KEY]: task.recurrence }),
  };
  let changes: Readonly<Record<string, unknown>>;
  try {
    changes = typeof values === 'function' ? values(properties) : values;
  } catch {
    // Refused against the row as read: the write refuses it as well, and says why.
    return null;
  }
  const ruled = taskRuleChanges({ before: { type: TASK_TYPE, ...properties }, changes, today });
  return 'refused' in ruled ? null : ruled.changes;
}
