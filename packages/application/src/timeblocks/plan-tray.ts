import {
  CHOSEN_TODAY_QUERY,
  declaresFocus,
  followsGtd,
  NEXT_ACTIONS_QUERY,
  taskTypeOf,
  trayOrder,
  type ObjectType,
  type TrayTask,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import { runAtlasQuery } from '../query/run-atlas-query.ts';
import { readTaskSchedules } from './task-schedules.ts';

interface TrayReads {
  index: IndexPort;
  types: readonly ObjectType[];
  notePaths: readonly string[];
}

/**
 * The tasks the planning tray offers (P31-02): the open tasks chosen for
 * today first (#108), whatever their status, then the next actions, as the
 * Next actions view lists them — a task deferred to a later day stays out
 * until that day — each with what its blocks give it, the ones with no time
 * yet first. Throws what the queries or the schedule throw, for the tray to say.
 */
export async function readPlanTray(reads: TrayReads): Promise<TrayTask[]> {
  const { index, types } = reads;
  const [chosen, next] = await Promise.all([
    chosenTasks(reads),
    listedBy(reads, NEXT_ACTIONS_QUERY),
  ]);
  const picked = new Set(chosen.map((task) => task.path));
  const listed = [
    ...chosen.map((task) => ({ ...task, chosen: true })),
    ...next.filter((task) => !picked.has(task.path)).map((task) => ({ ...task, chosen: false })),
  ];
  const schedules = await readTaskSchedules({
    index,
    paths: listed.map((task) => task.path),
    taskType: taskTypeOf(types),
  });
  return trayOrder(listed.map((task) => ({ ...task, schedule: schedules.get(task.path) ?? null })));
}

/**
 * The tasks chosen for today — asked only of a Task type on GTD's statuses
 * that has `focus` as a date: of any other, the query would be refused.
 */
function chosenTasks(reads: TrayReads): Promise<{ path: string; title: string }[]> {
  const type = taskTypeOf(reads.types);
  if (type === null || !followsGtd(type) || !declaresFocus(type)) return Promise.resolve([]);
  return listedBy(reads, CHOSEN_TODAY_QUERY);
}

async function listedBy(
  { index, types, notePaths }: TrayReads,
  text: string,
): Promise<{ path: string; title: string }[]> {
  const { result } = await runAtlasQuery({ index, text, types, notePaths });
  const column = (name: string) => result.columns.indexOf(name);
  return result.rows.map((row) => ({
    path: String(row[column('path')]),
    title: String(row[column('title')]),
  }));
}
