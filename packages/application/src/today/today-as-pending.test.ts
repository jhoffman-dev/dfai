import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  focusChange,
  taskDeferral,
  todayLists,
  TASK_KEYS,
  type ReviewTask,
  type TodaySectionId,
  type VaultPath,
} from '@dfai/domain';
import { archiveTaskChange } from '../review/review-actions.ts';
import type { PropertyChanges } from '../query/set-property.ts';
import type { TodayReport } from './read-today.ts';
import { todayAsPending } from './today-as-pending.ts';

/** #260: the Today page as it is drawn while the page's own changes are being written. */
const TODAY = '2026-10-13';
const NOW = Date.UTC(2026, 9, 13, 15);
const DAY = 86_400_000;

const path = (title: string) => createVaultPath(`Tasks/${title}.md`);

function task(title: string, fields: Partial<ReviewTask>): ReviewTask {
  return {
    path: path(title),
    title,
    status: 'next-action',
    due: null,
    defer: null,
    recurrence: null,
    waitingOn: '',
    contexts: [],
    project: null,
    projectTitle: null,
    modified: NOW - DAY,
    ...fields,
  };
}

const TASKS: readonly ReviewTask[] = [
  task('Renew the licence', { status: 'backlog', due: '2026-10-10' }),
  task('Send the figures', { due: TODAY }),
  task('Draft the plan', { status: 'in-progress' }),
  task('Call the bank', {}),
  task('Sow the beans', {}),
  task('Quote from Larkspur', {
    status: 'waiting',
    waitingOn: 'Mara Quill',
    modified: NOW - 4 * DAY,
  }),
];

function report(): TodayReport {
  const lists = todayLists({ tasks: TASKS, projects: [], at: { today: TODAY, now: NOW } });
  return {
    ...lists,
    stalledProjects: 2,
    today: TODAY,
    inbox: { count: 3, toFile: 2, toAnswer: 1, more: false },
    truncated: false,
  };
}

const titlesIn = (shown: TodayReport, id: TodaySectionId) =>
  shown.sections
    .find((section) => section.id === id)
    ?.groups.flatMap((group) => group.tasks.map((each) => each.title));

const countOf = (shown: TodayReport, id: TodaySectionId) =>
  shown.sections.find((section) => section.id === id)?.count;

const tasksOf = (shown: TodayReport) =>
  shown.sections.flatMap((section) => section.groups.flatMap((group) => group.tasks));

const pending = (...changes: (readonly [string, PropertyChanges])[]) =>
  new Map<VaultPath, PropertyChanges>(changes.map(([title, values]) => [path(title), values]));

describe('todayAsPending', () => {
  it('is the read itself while nothing is being written', () => {
    const read = report();
    expect(todayAsPending({ report: read, pending: new Map() })).toBe(read);
  });

  it('is the read itself when what is being written is not on the page', () => {
    const read = report();
    const shown = todayAsPending({
      report: read,
      pending: pending(['Not on the page', { [TASK_KEYS.status]: 'archive' }]),
    });
    expect(shown).toBe(read);
  });

  it('takes a task ticked done off the page at once, and counts it out', () => {
    const read = report();
    const shown = todayAsPending({
      report: read,
      pending: pending(['Draft the plan', archiveTaskChange()]),
    });
    expect(titlesIn(shown, 'inProgress')).toEqual([]);
    expect(countOf(shown, 'inProgress')).toBe(0);
    expect(shown.sections.find((section) => section.id === 'inProgress')?.groups).toEqual([]);
  });

  it('takes a task deferred to a later day off the page', () => {
    const deferral = taskDeferral({ today: TODAY, days: 1 }) ?? {};
    const shown = todayAsPending({
      report: report(),
      pending: pending(['Renew the licence', deferral]),
    });
    expect(titlesIn(shown, 'overdue')).toEqual([]);
  });

  it('puts a task moved to another status in the section that status lists it in', () => {
    const shown = todayAsPending({
      report: report(),
      pending: pending(['Call the bank', { [TASK_KEYS.status]: 'in-progress' }]),
    });
    expect(titlesIn(shown, 'nextActions')).toEqual(['Sow the beans']);
    expect(titlesIn(shown, 'inProgress')).toEqual(['Call the bank', 'Draft the plan']);
    expect(countOf(shown, 'inProgress')).toBe(2);
  });

  it('leaves a late task under Overdue when it is moved, as the page would read it', () => {
    const shown = todayAsPending({
      report: report(),
      pending: pending(['Renew the licence', { [TASK_KEYS.status]: 'waiting' }]),
    });
    expect(titlesIn(shown, 'overdue')).toEqual(['Renew the licence']);
    expect(titlesIn(shown, 'waiting')).toEqual(['Quote from Larkspur']);
  });

  it('counts a task just moved to Waiting from now, as its write will leave it: no days, and the newest', () => {
    const shown = todayAsPending({
      report: report(),
      pending: pending(['Call the bank', { [TASK_KEYS.status]: 'waiting' }]),
    });
    const waiting = tasksOf(shown).filter((each) => each.status === 'waiting');
    expect(waiting.map((each) => [each.title, each.waitingDays])).toEqual([
      ['Quote from Larkspur', 4],
      ['Call the bank', 0],
    ]);
  });

  it('keeps every task it did not change as the object the read made, so its row is not drawn again', () => {
    const read = report();
    const shown = todayAsPending({
      report: read,
      pending: pending(['Call the bank', { [TASK_KEYS.status]: 'in-progress' }]),
    });
    const before = new Map(tasksOf(read).map((each) => [each.path, each]));
    const untouched = tasksOf(shown).filter((each) => each.path !== path('Call the bank'));
    expect(untouched).toHaveLength(TASKS.length - 1);
    for (const each of untouched) expect(each).toBe(before.get(each.path));
  });

  it('keeps what the read said beyond the sections', () => {
    const read = report();
    const shown = todayAsPending({
      report: read,
      pending: pending(['Draft the plan', archiveTaskChange()]),
    });
    expect(shown).toMatchObject({
      today: TODAY,
      stalledProjects: 2,
      inbox: read.inbox,
      truncated: false,
    });
  });

  it('shows a task as read when its change cannot be worked out from the row', () => {
    const read = report();
    const refused: PropertyChanges = () => {
      throw new Error('refused');
    };
    const shown = todayAsPending({ report: read, pending: pending(['Call the bank', refused]) });
    expect(titlesIn(shown, 'nextActions')).toEqual(['Call the bank', 'Sow the beans']);
  });

  it('works out a change given as a rule against the task as its row read it', () => {
    const seen: unknown[] = [];
    const rule: PropertyChanges = (properties) => {
      seen.push(properties);
      return { [TASK_KEYS.status]: 'someday' };
    };
    const shown = todayAsPending({
      report: report(),
      pending: pending(['Send the figures', rule]),
    });
    expect(seen).toEqual([
      { status: 'next-action', due: TODAY, defer: null, focus: null, recurrence: null },
    ]);
    // Someday promises no day, so a task due today that is put to Someday leaves the page.
    expect(titlesIn(shown, 'dueToday')).toEqual([]);
  });
});

describe('todayAsPending — repeating work (#260, PR #274)', () => {
  it('draws a repeating task ticked done where its roll puts it: back in play, due next time', () => {
    const daily = task('Water the plants', {
      status: 'in-progress',
      due: '2026-10-10',
      recurrence: 'daily',
    });
    const read = reportOf([daily]);
    const shown = todayAsPending({
      report: read,
      pending: pending(['Water the plants', archiveTaskChange()]),
    });
    const drawn = tasksOf(shown).find((each) => each.path === daily.path);
    expect(drawn).toMatchObject({ status: 'next-action', due: '2026-10-11' });
    expect(titlesIn(shown, 'overdue')).toEqual(['Water the plants']);
  });

  it('leaves a task as read when the row did not say whether it repeats', () => {
    const unread: ReviewTask = { ...task('Water the plants', { status: 'in-progress' }) };
    delete (unread as { recurrence?: string | null }).recurrence;
    const read = reportOf([unread]);
    const shown = todayAsPending({
      report: read,
      pending: pending(['Water the plants', archiveTaskChange()]),
    });
    expect(titlesIn(shown, 'inProgress')).toEqual(['Water the plants']);
  });
});

function reportOf(tasks: readonly ReviewTask[]): TodayReport {
  return {
    ...todayLists({ tasks, projects: [], at: { today: TODAY, now: NOW } }),
    today: TODAY,
    inbox: { count: 0, toFile: 0, toAnswer: 0, more: false },
    truncated: false,
  };
}

describe('todayAsPending, choosing for today (#108)', () => {
  const chosenReport = (tasks: readonly ReviewTask[]): TodayReport => ({
    ...todayLists({ tasks, projects: [], at: { today: TODAY, now: NOW } }),
    today: TODAY,
    inbox: { count: 0, toFile: 0, toAnswer: 0, more: false },
    truncated: false,
  });

  it('draws a task being chosen under Chosen for today at once, and out of Next actions', () => {
    const shown = todayAsPending({
      report: report(),
      pending: pending(['Call the bank', focusChange({ choice: 'choose', today: TODAY })]),
    });
    expect(titlesIn(shown, 'chosen')).toEqual(['Call the bank']);
    expect(titlesIn(shown, 'nextActions')).toEqual(['Sow the beans']);
  });

  it('draws a chosen task being taken off back in the section of its status', () => {
    const read = chosenReport([
      task('Draft the plan', { status: 'in-progress', focus: TODAY }),
      task('Sow the beans', {}),
    ]);
    expect(titlesIn(read, 'chosen')).toEqual(['Draft the plan']);
    const shown = todayAsPending({
      report: read,
      pending: pending(['Draft the plan', focusChange({ choice: 'unchoose', today: TODAY })]),
    });
    expect(titlesIn(shown, 'chosen')).toEqual([]);
    expect(titlesIn(shown, 'inProgress')).toEqual(['Draft the plan']);
  });

  it('draws one carried over as kept under Chosen, or as dropped where its status puts it', () => {
    const read = chosenReport([
      task('Call the bank', { focus: '2026-10-12' }),
      task('Sow the beans', { focus: '2026-10-12' }),
    ]);
    expect(titlesIn(read, 'carriedOver')).toEqual(['Call the bank', 'Sow the beans']);
    const shown = todayAsPending({
      report: read,
      pending: pending(
        ['Call the bank', focusChange({ choice: 'keep', today: TODAY })],
        ['Sow the beans', focusChange({ choice: 'drop', today: TODAY })],
      ),
    });
    expect(titlesIn(shown, 'chosen')).toEqual(['Call the bank']);
    expect(titlesIn(shown, 'carriedOver')).toEqual([]);
    expect(titlesIn(shown, 'nextActions')).toEqual(['Sow the beans']);
  });
});
