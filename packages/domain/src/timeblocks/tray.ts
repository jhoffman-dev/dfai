import type { TaskSchedule } from './scheduling.ts';

/** A task the planning tray offers to the calendar, with what its blocks give it so far. */
export interface TrayTask {
  readonly path: string;
  readonly title: string;
  /** Null when its schedule could not be read. */
  readonly schedule: TaskSchedule | null;
  /** Whether it was chosen for today (#108), which puts it first. */
  readonly chosen: boolean;
}

/** Whether no block gives the task any time yet. */
export const isUnscheduled = (task: TrayTask): boolean => (task.schedule?.scheduled ?? 0) === 0;

/**
 * The tray's tasks in the order it lists them (P31-02): those chosen for
 * today first (#108), then the rest; within each, the tasks with no time set
 * aside yet first, then those that have some, each part in the order they
 * were read — so what was chosen, and still needs planning, is at the top.
 */
export function trayOrder(tasks: readonly TrayTask[]): TrayTask[] {
  const chosen = tasks.filter((task) => task.chosen);
  const rest = tasks.filter((task) => !task.chosen);
  return [...unscheduledFirst(chosen), ...unscheduledFirst(rest)];
}

function unscheduledFirst(tasks: readonly TrayTask[]): TrayTask[] {
  return [...tasks.filter(isUnscheduled), ...tasks.filter((task) => !isUnscheduled(task))];
}
