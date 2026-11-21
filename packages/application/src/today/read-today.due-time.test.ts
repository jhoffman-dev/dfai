import { describe, expect, it } from 'vitest';
import type { TodaySectionId } from '@dfai/domain';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';
import { readWeeklyReview } from '../review/read-weekly-review.ts';
import { readToday, type TodayReport } from './read-today.ts';
import { todayAsPending } from './today-as-pending.ts';

/** #928: a timed due read from a vault's index onto the Today page, on a fixed clock. */
const NOW = Date.UTC(2026, 11, 4, 15, 30);
const clockAt = (time: string) => ({
  today: () => '2026-12-04',
  now: () => NOW,
  localNow: () => `2026-12-04T${time}:12`,
});

const task = (...frontmatter: string[]) =>
  ['---', 'type: task', 'status: next-action', ...frontmatter, '---', ''].join('\n');

const FILES = {
  'Tasks/Call Mara Quill.md': task('due: 2026-12-04T15:30'),
  'Tasks/Pay Larkspur Payroll.md': task('due: 2026-12-04'),
  'Tasks/Write to Tobias Fenn.md': task('due: 2026-12-04 09:00'),
};

const ports = () => ({
  index: fakeIndexPort({ query: atlasQueryIndex({ markdown: fakeMarkdown(), files: FILES }) }),
  fs: fakeVaultFs(),
  markdown: fakeMarkdown(),
});

const titles = (report: TodayReport, id: TodaySectionId) =>
  report.sections
    .find((section) => section.id === id)
    ?.groups.flatMap((group) => group.tasks.map((item) => item.title)) ?? [];

describe('readToday, a due with a time (#928)', () => {
  it('lists a timed due under Due today until its time passes, by time after the date-only', async () => {
    const report = await readToday({ ...ports(), clock: clockAt('08:59') });
    expect(report.time).toBe('08:59');
    expect(titles(report, 'dueToday')).toEqual([
      'Pay Larkspur Payroll',
      'Write to Tobias Fenn',
      'Call Mara Quill',
    ]);
    const call = report.sections
      .flatMap((section) => section.groups.flatMap((group) => group.tasks))
      .find((item) => item.title === 'Call Mara Quill');
    expect(call).toMatchObject({ due: '2026-12-04', dueTime: '15:30' });
  });

  it('moves it to Overdue the minute after its time, and leaves the date-only due due today', async () => {
    const at1529 = await readToday({ ...ports(), clock: clockAt('15:29') });
    expect(titles(at1529, 'overdue')).toEqual(['Write to Tobias Fenn']);
    const at1531 = await readToday({ ...ports(), clock: clockAt('15:31') });
    expect(titles(at1531, 'overdue')).toEqual(['Write to Tobias Fenn', 'Call Mara Quill']);
    expect(titles(at1531, 'dueToday')).toEqual(['Pay Larkspur Payroll']);
  });

  it('reads every due by its day when the clock does not tell the wall time', async () => {
    const report = await readToday({
      ...ports(),
      clock: { today: () => '2026-12-04', now: () => NOW },
    });
    expect(report.time).toBeNull();
    expect(titles(report, 'overdue')).toEqual([]);
    expect(titles(report, 'dueToday')).toHaveLength(3);
  });

  it('keeps the wall time it was read at when a write is drawn before it lands', async () => {
    const report = await readToday({ ...ports(), clock: clockAt('15:31') });
    const pay = report.sections
      .flatMap((section) => section.groups.flatMap((group) => group.tasks))
      .find((item) => item.title === 'Pay Larkspur Payroll');
    if (pay === undefined) throw new Error('no task');
    const drawn = todayAsPending({
      report,
      pending: new Map([[pay.path, { contexts: ['@desk'] }]]),
    });
    expect(titles(drawn, 'overdue')).toEqual(['Write to Tobias Fenn', 'Call Mara Quill']);
  });

  it('counts a timed due today whose time has passed as overdue in the weekly review', async () => {
    const review = await readWeeklyReview({ ...ports(), clock: clockAt('12:00') });
    expect(review.overdue.map((item) => item.title)).toEqual(['Write to Tobias Fenn']);
  });
});
