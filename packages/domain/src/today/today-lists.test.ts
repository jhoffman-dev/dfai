import { describe, expect, it } from 'vitest';
import { GTD_STATUSES, type GtdStatus } from '../gtd/gtd-status.ts';
import type { ReviewProject, ReviewTask } from '../review/weekly-review.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  rowToFocusAfter,
  TODAY_MOVES,
  todayMovesFor,
  TODAY_SECTIONS,
  todayLists,
  todayRowOrder,
  type TodaySectionId,
} from './today-lists.ts';

/** #111: the Today page's rules, on a fixed clock. */
const TODAY = '2026-10-13';
const NOW = Date.UTC(2026, 9, 13, 15);
const DAY = 86_400_000;
const AT = { today: TODAY, now: NOW };

const ATLAS = createVaultPath('Projects/DFAI.md');
const GARDEN = createVaultPath('Projects/Garden.md');

function task(
  title: string,
  fields: Partial<Omit<ReviewTask, 'path' | 'title'>> & { daysAgo?: number } = {},
): ReviewTask {
  const { daysAgo = 0, ...rest } = fields;
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
    modified: NOW - daysAgo * DAY,
    ...rest,
  };
}

const inAtlas = { project: ATLAS, projectTitle: 'DFAI' };
const inGarden = { project: GARDEN, projectTitle: 'Garden' };

const project = (title: string, fields: Partial<ReviewProject> = {}): ReviewProject => ({
  path: createVaultPath(`Projects/${title}.md`),
  title,
  status: 'active',
  moving: false,
  ...fields,
});

const lists = (tasks: readonly ReviewTask[], at = AT) => todayLists({ tasks, projects: [], at });
const section = (tasks: readonly ReviewTask[], id: TodaySectionId, at = AT) => {
  const found = lists(tasks, at).sections.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no section ${id}`);
  return found;
};
const titlesIn = (tasks: readonly ReviewTask[], id: TodaySectionId, at = AT) =>
  section(tasks, id, at).groups.flatMap((group) => group.tasks.map((item) => item.title));
/** Which section each task landed in, by title; a task in none is absent. */
const placed = (tasks: readonly ReviewTask[], at = AT) =>
  Object.fromEntries(
    lists(tasks, at).sections.flatMap((found) =>
      found.groups.flatMap((group) => group.tasks.map((item) => [item.title, found.id])),
    ),
  );

describe('todayLists', () => {
  it('always yields every section, in order, empty ones with no groups', () => {
    const { sections } = lists([]);
    expect(sections.map((found) => found.id)).toEqual([...TODAY_SECTIONS]);
    expect(sections.every((found) => found.count === 0 && found.groups.length === 0)).toBe(true);
  });

  it('puts each task in the section it belongs to, and counts them', () => {
    const tasks = [
      task('Late', { due: '2026-10-10' }),
      task('Due now', { due: TODAY }),
      task('Woke up', { defer: TODAY, status: 'someday' }),
      task('Under way', { status: 'in-progress' }),
      task('Next', {}),
      task('Chase', { status: 'waiting', waitingOn: 'Mara Quill' }),
      task('Idea', { status: 'someday' }),
      task('Unsorted', { status: 'inbox' }),
      task('Parked', { status: 'backlog' }),
      task('Unknown', { status: null }),
    ];
    expect(placed(tasks)).toEqual({
      Late: 'overdue',
      'Due now': 'dueToday',
      'Woke up': 'backToday',
      'Under way': 'inProgress',
      Next: 'nextActions',
      Chase: 'waiting',
    });
    expect(lists(tasks).sections.map((found) => found.count)).toEqual([0, 0, 1, 1, 1, 1, 1, 1]);
  });

  it('lists a task once, in the first section that claims it', () => {
    const tasks = [
      task('Late and under way', { due: '2026-10-01', status: 'in-progress' }),
      task('Due and back', { due: TODAY, defer: TODAY }),
      task('Back and waiting', { defer: TODAY, status: 'waiting', waitingOn: 'Mara Quill' }),
      task('Late and waiting', { due: '2026-10-12', status: 'waiting', waitingOn: 'Mara Quill' }),
    ];
    expect(placed(tasks)).toEqual({
      'Late and under way': 'overdue',
      'Due and back': 'dueToday',
      'Back and waiting': 'backToday',
      'Late and waiting': 'overdue',
    });
    const counted = lists(tasks).sections.reduce((sum, found) => sum + found.count, 0);
    expect(counted).toBe(tasks.length);
  });
});

describe('date edges', () => {
  it('calls a task due today due, not overdue, and one due yesterday overdue', () => {
    const tasks = [task('Today', { due: TODAY }), task('Yesterday', { due: '2026-10-12' })];
    expect(placed(tasks)).toEqual({ Today: 'dueToday', Yesterday: 'overdue' });
  });

  it('leaves a task due tomorrow out of both', () => {
    expect(placed([task('Tomorrow', { due: '2026-10-14', status: 'backlog' })])).toEqual({});
  });

  it('turns on the day the clock gives, not on how late in it now is', () => {
    const due = [task('Report', { due: TODAY })];
    // The last second of the 13th and the first of the 14th, where the clock is.
    const lastSecond = { today: TODAY, now: Date.UTC(2026, 9, 13, 23, 59, 59) };
    const midnight = { today: '2026-10-14', now: Date.UTC(2026, 9, 14, 0, 0, 0) };
    expect(placed(due, lastSecond)).toEqual({ Report: 'dueToday' });
    expect(placed(due, midnight)).toEqual({ Report: 'overdue' });
  });

  it('reads the day a clock change falls on like any other', () => {
    // 2026-11-01: clocks go back in the US, and the day is 25 hours long.
    const fallBack = { today: '2026-11-01', now: Date.UTC(2026, 10, 1, 9, 30) };
    const tasks = [
      task('Before', { due: '2026-10-31' }),
      task('On', { due: '2026-11-01' }),
      task('Wakes', { defer: '2026-11-01', status: 'backlog' }),
      task('After', { defer: '2026-11-02' }),
    ];
    expect(placed(tasks, fallBack)).toEqual({
      Before: 'overdue',
      On: 'dueToday',
      Wakes: 'backToday',
    });
  });

  it('says late and due only of open work', () => {
    const statuses: readonly (GtdStatus | null)[] = [...GTD_STATUSES, null];
    const late = statuses.map((status) => task(`late ${status}`, { due: '2026-10-01', status }));
    const due = statuses.map((status) => task(`due ${status}`, { due: TODAY, status }));
    const open = ['inbox', 'backlog', 'next-action', 'in-progress', 'waiting'];
    expect(titlesIn(late, 'overdue').sort()).toEqual(open.map((s) => `late ${s}`).sort());
    expect(titlesIn(due, 'dueToday').sort()).toEqual(open.map((s) => `due ${s}`).sort());
  });
});

describe('deferral', () => {
  it('keeps a task deferred past today out of every section, whatever else is true of it', () => {
    const later = { defer: '2026-10-14' };
    const tasks = [
      task('Late', { ...later, due: '2026-10-01' }),
      task('Due', { ...later, due: TODAY }),
      task('Under way', { ...later, status: 'in-progress' }),
      task('Next', later),
      task('Chase', { ...later, status: 'waiting', waitingOn: 'Mara Quill' }),
    ];
    expect(placed(tasks)).toEqual({});
  });

  it('brings a task back on its defer day, under Back from deferral, whatever its status', () => {
    const tasks = [
      task('Next', { defer: TODAY }),
      task('Idea', { defer: TODAY, status: 'someday' }),
      task('Unknown', { defer: TODAY, status: null }),
    ];
    expect(titlesIn(tasks, 'backToday')).toEqual(['Idea', 'Next']);
  });

  it('lists a task whose defer day has passed where its status puts it, when a section lists that status', () => {
    const passed = { defer: '2026-10-12' };
    const tasks = [
      task('Next', passed),
      task('Under way', { ...passed, status: 'in-progress' }),
      task('Chase', { ...passed, status: 'waiting', waitingOn: 'Mara Quill' }),
    ];
    expect(placed(tasks)).toEqual({
      Next: 'nextActions',
      'Under way': 'inProgress',
      Chase: 'waiting',
    });
  });

  it('still wakes a task whose defer day passed unseen, when no other section would list it', () => {
    const tasks = [
      task('Parked', { defer: '2026-10-09', status: 'backlog' }),
      task('Idea', { defer: '2026-09-01', status: 'someday' }),
      task('Far', { defer: '2026-10-12', status: 'longterm' }),
      task('Unsorted', { defer: '2026-10-12', status: 'inbox' }),
      task('Fresh', { defer: TODAY, status: 'backlog' }),
      task('Late', { defer: '2026-10-09', status: 'backlog', due: '2026-10-01' }),
      task('Never deferred', { status: 'backlog' }),
    ];
    // Today's first, then the most recently woken; a late one is under Overdue.
    expect(titlesIn(tasks, 'backToday')).toEqual(['Fresh', 'Far', 'Unsorted', 'Parked', 'Idea']);
    expect(placed(tasks)['Late']).toBe('overdue');
    expect(placed(tasks)['Never deferred']).toBeUndefined();
  });

  it('lists no finished task, whatever its days say', () => {
    const tasks = [
      task('Done back', { status: 'archive', defer: TODAY }),
      task('Done late', { status: 'archive', due: '2026-10-01' }),
      task('Done due', { status: 'archive', due: TODAY }),
    ];
    expect(placed(tasks)).toEqual({});
  });
});

describe('ordering', () => {
  it('lists overdue the earliest first, then by title', () => {
    const tasks = [
      task('B', { due: '2026-10-12' }),
      task('A', { due: '2026-10-12' }),
      task('C', { due: '2026-09-01' }),
    ];
    expect(titlesIn(tasks, 'overdue')).toEqual(['C', 'A', 'B']);
  });

  it('lists in-progress tasks with a day first, the earliest first', () => {
    const tasks = [
      task('No day', { status: 'in-progress' }),
      task('Later', { status: 'in-progress', due: '2026-11-01' }),
      task('Sooner', { status: 'in-progress', due: '2026-10-20' }),
    ];
    expect(titlesIn(tasks, 'inProgress')).toEqual(['Sooner', 'Later', 'No day']);
  });
});

describe('next actions', () => {
  it('groups them by project, by title, with those under no project last', () => {
    const tasks = [
      task('Loose end'),
      task('Sow beans', inGarden),
      task('Ship it', inAtlas),
      task('Another loose end'),
      task('Fix the build', { ...inAtlas, due: '2026-10-20' }),
    ];
    const groups = section(tasks, 'nextActions').groups;
    expect(groups.map((group) => [group.label, group.tasks.map((item) => item.title)])).toEqual([
      ['DFAI', ['Fix the build', 'Ship it']],
      ['Garden', ['Sow beans']],
      [null, ['Another loose end', 'Loose end']],
    ]);
    expect(groups.map((group) => group.project)).toEqual([ATLAS, GARDEN, null]);
    expect(section(tasks, 'nextActions').count).toBe(5);
  });

  it('keeps two projects of one title apart', () => {
    const other = createVaultPath('Archive Ideas/DFAI.md');
    const tasks = [task('One', inAtlas), task('Two', { project: other, projectTitle: 'DFAI' })];
    expect(section(tasks, 'nextActions').groups.map((group) => group.key)).toEqual([other, ATLAS]);
  });
});

describe('waiting', () => {
  it('groups by who is waited on, nobody last, the longest wait first', () => {
    const tasks = [
      task('Signature', { status: 'waiting', waitingOn: 'Tobias Fenn', daysAgo: 3 }),
      task('Quote', { status: 'waiting', waitingOn: 'Mara Quill', daysAgo: 2 }),
      task('Orphan', { status: 'waiting', daysAgo: 9 }),
      task('Reply', { status: 'waiting', waitingOn: 'Mara Quill', daysAgo: 12 }),
    ];
    const groups = section(tasks, 'waiting').groups;
    expect(groups.map((group) => [group.label, group.tasks.map((item) => item.title)])).toEqual([
      ['Mara Quill', ['Reply', 'Quote']],
      ['Tobias Fenn', ['Signature']],
      [null, ['Orphan']],
    ]);
  });

  it('counts whole days since the file last changed, never less than none', () => {
    const waiting = (modified: number) =>
      section([task('Quote', { status: 'waiting', waitingOn: 'Mara Quill', modified })], 'waiting')
        .groups[0]?.tasks[0]?.waitingDays;
    expect(waiting(NOW)).toBe(0);
    expect(waiting(NOW - DAY + 1)).toBe(0);
    expect(waiting(NOW - DAY)).toBe(1);
    expect(waiting(NOW - 12 * DAY - 5000)).toBe(12);
    // A file dated ahead of the clock, as a sync from another Mac can leave it.
    expect(waiting(NOW + DAY)).toBe(0);
  });

  it('gives no wait to a task that is not Waiting, and keeps one for a Waiting task listed as late', () => {
    const tasks = [
      task('Next', { daysAgo: 5 }),
      task('Late', { status: 'waiting', waitingOn: 'Mara Quill', due: '2026-10-01', daysAgo: 4 }),
    ];
    expect(section(tasks, 'nextActions').groups[0]?.tasks[0]?.waitingDays).toBeNull();
    expect(section(tasks, 'overdue').groups[0]?.tasks[0]?.waitingDays).toBe(4);
  });
});

describe('stalled projects', () => {
  it('counts the active projects the index says are not moving', () => {
    const projects = [
      project('Garden'),
      project('DFAI', { moving: true }),
      project('Shed', { status: 'paused' }),
      project('Beds'),
    ];
    expect(todayLists({ tasks: [], projects, at: AT }).stalledProjects).toBe(2);
  });
});

describe('moves', () => {
  it('offers every status but Archive, which is the done box’s', () => {
    expect(TODAY_MOVES).toEqual([
      'inbox',
      'backlog',
      'next-action',
      'in-progress',
      'waiting',
      'someday',
      'longterm',
    ]);
  });
});

describe('moves for one task', () => {
  it('offers every move but the task’s own status', () => {
    expect(todayMovesFor('waiting')).toEqual(TODAY_MOVES.filter((status) => status !== 'waiting'));
    expect(todayMovesFor(null)).toEqual(TODAY_MOVES);
  });
});

describe('row focus', () => {
  const tasks = [
    task('Late', { due: '2026-10-01' }),
    task('Under way', { status: 'in-progress' }),
    task('Ship it', inAtlas),
    task('Loose end'),
  ];
  const order = todayRowOrder(lists(tasks));
  const path = (title: string) => createVaultPath(`Tasks/${title}.md`);

  it('orders the rows as the page lists them, top to bottom', () => {
    expect(order).toEqual(['Late', 'Under way', 'Ship it', 'Loose end'].map(path));
  });

  it('moves focus to the row under the one acted on, or the one above the last', () => {
    expect(rowToFocusAfter({ order, acted: path('Late') })).toBe(path('Under way'));
    expect(rowToFocusAfter({ order, acted: path('Under way') })).toBe(path('Ship it'));
    expect(rowToFocusAfter({ order, acted: path('Loose end') })).toBe(path('Ship it'));
  });

  it('has nowhere to go from the only row, or from a row that is not there', () => {
    expect(rowToFocusAfter({ order: [path('Late')], acted: path('Late') })).toBeNull();
    expect(rowToFocusAfter({ order, acted: path('Gone') })).toBeNull();
  });
});
