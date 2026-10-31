import { describe, expect, it } from 'vitest';
import { createVaultPath, todayLists, type ReviewTask } from '@dfai/domain';
import type { TodayReport } from '@dfai/application';
import { keptTodayReport } from './kept-today-report.ts';

const NOW = Date.UTC(2026, 9, 13, 15);

const task = (title: string, fields: Partial<ReviewTask> = {}): ReviewTask => ({
  path: createVaultPath(`Tasks/${title}.md`),
  title,
  status: 'next-action',
  due: null,
  defer: null,
  waitingOn: '',
  contexts: [],
  project: null,
  projectTitle: null,
  modified: NOW,
  ...fields,
});

function report(tasks: readonly ReviewTask[]): TodayReport {
  return {
    ...todayLists({ tasks, projects: [], at: { today: '2026-10-13', now: NOW } }),
    today: '2026-10-13',
    choosing: true,
    inbox: { count: 0, toFile: 0, toAnswer: 0, more: false },
    truncated: false,
    stalledProjects: 0,
  };
}

const tasksOf = (read: TodayReport) =>
  read.sections.flatMap((section) => section.groups.flatMap((group) => group.tasks));
const find = (read: TodayReport, title: string) =>
  tasksOf(read).find((each) => each.title === title);

describe('keptTodayReport', () => {
  it('is the read itself when there was none before', () => {
    const next = report([task('Ship the page')]);
    expect(keptTodayReport(null, next)).toBe(next);
  });

  it('keeps a task that reads the same, even moved to another section', () => {
    const before = report([task('Ship the page'), task('Call the bank')]);
    const next = report([
      task('Ship the page'),
      task('Call the bank', { status: 'in-progress' }),
      task('Write the guide'),
    ]);

    const kept = keptTodayReport(before, next);

    expect(find(kept, 'Ship the page')).toBe(find(before, 'Ship the page'));
    expect(find(kept, 'Call the bank')).not.toBe(find(before, 'Call the bank'));
    expect(find(kept, 'Call the bank')?.status).toBe('in-progress');
    expect(tasksOf(kept).map((each) => each.title)).toEqual(
      tasksOf(next).map((each) => each.title),
    );
  });

  it('hands over a new object for a task whose file changed, though nothing it shows did', () => {
    const before = report([task('Ship the page')]);
    const next = report([task('Ship the page', { modified: NOW + 60_000 })]);

    const kept = keptTodayReport(before, next);

    expect(find(kept, 'Ship the page')).not.toBe(find(before, 'Ship the page'));
    expect(find(kept, 'Ship the page')?.modified).toBe(NOW + 60_000);
  });

  it('keeps what the read says of the day and the Inbox, not what was said before', () => {
    const before = report([task('Ship the page')]);
    const next = { ...report([task('Ship the page')]), inbox: { ...before.inbox, count: 4 } };
    expect(keptTodayReport(before, next).inbox.count).toBe(4);
  });
});
