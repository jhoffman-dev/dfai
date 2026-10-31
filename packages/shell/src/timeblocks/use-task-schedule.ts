import { useEffect, useState } from 'react';
import {
  messageWithoutPaths,
  TASK_TYPE,
  taskTypeOf,
  type TaskSchedule,
  type VaultPath,
} from '@dfai/domain';
import { readTaskSchedules, type DefinedType, type IndexPort } from '@dfai/application';

/** What a task's page shows of its schedule: it, or why it could not be read. */
export type TaskScheduleState = { schedule: TaskSchedule } | { problem: string };

/**
 * The open task's estimate, scheduled and done (P31-01), read again whenever
 * the index changes — a block written, a task's estimate edited. Null for a
 * note that is not a task, or one the index does not hold yet.
 */
export function useTaskSchedule({
  index,
  types,
  path,
  typeName,
  indexKey,
}: {
  index: IndexPort;
  types: readonly DefinedType[];
  path: VaultPath | null;
  typeName: string | null;
  indexKey: string;
}): TaskScheduleState | null {
  const [state, setState] = useState<{ for: VaultPath; state: TaskScheduleState } | null>(null);
  const isTask = path !== null && typeName?.trim().toLowerCase() === TASK_TYPE;

  useEffect(() => {
    if (!isTask) return;
    let cancelled = false;
    readTaskSchedules({ index, paths: [path], taskType: taskTypeOf(types) })
      .then((schedules) => {
        if (cancelled) return;
        const schedule = schedules.get(path);
        setState(schedule === undefined ? null : { for: path, state: { schedule } });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setState({ for: path, state: { problem: messageWithoutPaths(cause) } });
      });
    return () => {
      cancelled = true;
    };
  }, [index, types, path, isTask, indexKey]);

  return isTask && state?.for === path ? state.state : null;
}
