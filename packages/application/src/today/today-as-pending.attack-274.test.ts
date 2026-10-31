import { describe, expect, it } from 'vitest';
import { createVaultPath, todayLists, TASK_KEYS, type ReviewTask } from '@dfai/domain';
import type { TodayReport } from './read-today.ts';
import { todayAsPending } from './today-as-pending.ts';

/**
 * Adversarial pass on #260 (PR #274): the pending draw must put a task where
 * the read-back will, or the row jumps when the index catches up. Waiting is
 * ordered by when each file last changed; a task moved there is written now,
 * so it is the newest — strictly — once read back.
 */
const TODAY = '2026-10-13';
const NOW = Date.UTC(2026, 9, 13, 15);
const DAY = 86_400_000;

function task(title: string, fields: Partial<ReviewTask>): ReviewTask {
  return {
    path: createVaultPath(`Tasks/${title}.md`),
    title,
    status: 'next-action',
    due: null,
    defer: null,
    waitingOn: '',
    contexts: [],
    project: null,
    projectTitle: null,
    modified: NOW - 2 * DAY,
    ...fields,
  };
}

function reportOf(tasks: readonly ReviewTask[]): TodayReport {
  const lists = todayLists({ tasks, projects: [], at: { today: TODAY, now: NOW } });
  return {
    ...lists,
    today: TODAY,
    choosing: true,
    inbox: { count: 0, toFile: 0, toAnswer: 0, more: false },
    truncated: false,
  };
}

const waitingTitles = (report: TodayReport) =>
  report.sections
    .find((section) => section.id === 'waiting')
    ?.groups.flatMap((group) => group.tasks.map((each) => each.title)) ?? [];

describe('todayAsPending — a task moved to Waiting is placed as its read-back places it', () => {
  it('puts it after the newest waiting task on the same person, as the read-back does', () => {
    // The page's newest file is a waiting task whose title sorts after the one moved.
    const zed = task('Zed the gate', { status: 'waiting', modified: NOW - DAY });
    const alpha = task('Alpha the order', {});
    const pending = todayAsPending({
      report: reportOf([zed, alpha]),
      pending: new Map([[alpha.path, { [TASK_KEYS.status]: 'waiting' }]]),
    });

    // The read once written: the moved file changed at the write, after every other.
    const readBack = reportOf([zed, { ...alpha, status: 'waiting', modified: NOW }]);

    // Expected ['Zed the gate', 'Alpha the order']; received ['Alpha the order', 'Zed the gate']:
    // the moved task is given the newest task's own `modified`, ties it, and sorts by title.
    expect(waitingTitles(pending)).toEqual(waitingTitles(readBack));
  });
});
