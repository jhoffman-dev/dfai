import type { TodayReport } from '@dfai/application';
import { keptWhereSame } from '../inbox/kept-where-same.ts';

const byPath = (task: { readonly path: string }) => task.path;

/**
 * `next`, with each task that reads the same as it did in `before` kept as
 * the object `before` held: the page draws a row again only for a task that
 * is a new object, and every read of the index makes new ones (#217). Null
 * before the first read, when there is nothing to keep.
 */
export function keptTodayReport(before: TodayReport | null, next: TodayReport): TodayReport {
  if (before === null) return next;
  const known = before.sections.flatMap((section) =>
    section.groups.flatMap((group) => group.tasks),
  );
  return {
    ...next,
    sections: next.sections.map((section) => ({
      ...section,
      groups: section.groups.map((group) => ({
        ...group,
        tasks: keptWhereSame(known, group.tasks, byPath),
      })),
    })),
  };
}
