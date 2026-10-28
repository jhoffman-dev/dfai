import {
  laterChoiceOf,
  RECURRENCE_KEY,
  taskAsRead,
  taskRuleChanges,
  TASK_TYPE,
  todayLists,
  TASK_KEYS,
  type TodayLists,
  type TodayTask,
  type VaultPath,
} from '@dfai/domain';
import type { PropertyChanges } from '../query/set-property.ts';
import type { TodayReport } from './read-today.ts';

/**
 * The Today page as it is drawn while the page's own changes are being
 * written (#260): each task a change is pending for, put where the change
 * leaves it — off the page once ticked done or deferred, in the section of
 * its new status once moved, under Chosen for today once chosen — by the page's own rules, before the write
 * lands and the index reads it back. Every other task is the object the read
 * made, so its row is not drawn again; the read itself when nothing changes.
 *
 * A change is worked out against the task as its row read it. One that
 * cannot be (a rule that refuses) leaves the task as read: the write will
 * refuse it too, and the row stays where it is.
 */
export function todayAsPending({
  report,
  pending,
}: {
  report: TodayReport;
  /** What is being written to each task, by its path. */
  pending: ReadonlyMap<VaultPath, PropertyChanges>;
}): TodayReport {
  const tasks = report.sections.flatMap((section) =>
    section.groups.flatMap((group) => group.tasks),
  );
  if (!tasks.some((task) => pending.has(task.path))) return report;
  const newest = tasks.reduce((latest, task) => Math.max(latest, task.modified), 0);
  const changed = new Map(
    tasks.flatMap((task) => {
      const values = pending.get(task.path);
      return values === undefined
        ? []
        : [[task.path, asChanged({ task, values, newest, report })] as const];
    }),
  );
  // Placed by the page's own rules; each task is then given back as the object
  // it is here, so the waiting days the read counted are kept as they were.
  const lists = todayLists({
    tasks: tasks.map((task) => changed.get(task.path) ?? task),
    projects: [],
    at: { today: report.today, now: newest },
    choosing: report.choosing,
  });
  const read = new Map(tasks.map((task) => [task.path, task]));
  return {
    ...report,
    sections: withTasks(lists, (task) => changed.get(task.path) ?? read.get(task.path) ?? task),
  };
}

/**
 * A task as a change leaves it. Written, its file changes now, after every
 * other on the page: it is strictly the newest, as its read-back will be, and
 * a Waiting task has waited no days yet. A change given as a rule is worked
 * out with the task's recurrence, so a repeating task ticked done is drawn
 * where its roll puts it; a row read without it is left as read, since what
 * the rule does cannot be known before it is written. The task rules are
 * held as the write holds them, so a tick that ends the day's choice draws
 * the task off Chosen for today (#108).
 */
function asChanged({
  task,
  values,
  newest,
  report: { today, choosing },
}: {
  task: TodayTask;
  values: PropertyChanges;
  newest: number;
  report: Pick<TodayReport, 'today' | 'choosing'>;
}): TodayTask {
  if (typeof values === 'function' && task.recurrence === undefined) return task;
  const properties = {
    [TASK_KEYS.status]: task.status,
    [TASK_KEYS.due]: task.due,
    [TASK_KEYS.defer]: task.defer,
    // A focus that is the person's own is not a choice the rules could end.
    ...(task.focusIsOwn !== true && { [TASK_KEYS.focus]: task.focus ?? null }),
    ...(task.recurrence !== undefined && { [RECURRENCE_KEY]: task.recurrence }),
  };
  let changes: Readonly<Record<string, unknown>>;
  try {
    changes = typeof values === 'function' ? values(properties) : values;
  } catch {
    // Refused against the row as read: the write refuses it as well, and says why.
    return task;
  }
  // The rules judge a task: the row is one, whatever its read carried.
  const ruled = taskRuleChanges({ before: { type: TASK_TYPE, ...properties }, changes, today });
  // Refused by the rules: the write refuses it too, and the row stays as read.
  if ('refused' in ruled) return task;
  changes = ruled.changes;
  const after = taskAsRead({ ...properties, ...changes });
  return {
    ...task,
    ...after,
    modified: newest + 1,
    waitingDays: after.status === 'waiting' ? 0 : null,
    laterChoice: laterChoiceOf({ ...task, focus: after.focus, today, choosing }),
  };
}

/** The sections, each task as `kept` gives it back. */
function withTasks(
  lists: TodayLists,
  kept: (task: TodayTask) => TodayTask,
): TodayReport['sections'] {
  return lists.sections.map((section) => ({
    ...section,
    groups: section.groups.map((group) => ({ ...group, tasks: group.tasks.map(kept) })),
  }));
}
