import { describe, expect, it } from 'vitest';
import { GTD_STATUSES } from '../gtd/gtd-status.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import type { ReviewTask } from '../review/weekly-review.ts';
import type { ObjectType, PropertyDef } from '../types/property-def.ts';
import { declaresFocus, FOCUS_PROPERTY, focusChange, focusStanding } from './chosen.ts';
import { todayLists, todayRowOrder, type TodaySectionId } from './today-lists.ts';

/** #108: choosing tasks for today, on a fixed clock. */
const TODAY = '2026-10-28';
const YESTERDAY = '2026-10-27';
const NOW = Date.UTC(2026, 9, 28, 15);
const AT = { today: TODAY, now: NOW };

function task(title: string, fields: Partial<Omit<ReviewTask, 'path' | 'title'>> = {}): ReviewTask {
  return {
    path: createVaultPath(`Tasks/${title}.md`),
    title,
    status: 'next-action',
    due: null,
    defer: null,
    focus: null,
    waitingOn: '',
    contexts: [],
    project: null,
    projectTitle: null,
    modified: NOW,
    ...fields,
  };
}

const placed = (tasks: readonly ReviewTask[]) =>
  Object.fromEntries(
    todayLists({ tasks, projects: [], at: AT }).sections.flatMap((section) =>
      section.groups.flatMap((group) => group.tasks.map((each) => [each.title, section.id])),
    ),
  );

const titlesIn = (tasks: readonly ReviewTask[], id: TodaySectionId) =>
  (
    todayLists({ tasks, projects: [], at: AT }).sections.find((section) => section.id === id)
      ?.groups ?? []
  ).flatMap((group) => group.tasks.map((each) => each.title));

describe('focusStanding', () => {
  it('is today for a task chosen for today', () => {
    expect(focusStanding({ focus: TODAY, today: TODAY })).toBe('today');
  });

  it('is carried for one chosen on an earlier day, however long ago', () => {
    expect(focusStanding({ focus: YESTERDAY, today: TODAY })).toBe('carried');
    expect(focusStanding({ focus: '2025-01-02', today: TODAY })).toBe('carried');
  });

  it('is none for a task not chosen, or chosen for a day still to come', () => {
    expect(focusStanding({ focus: null, today: TODAY })).toBe('none');
    expect(focusStanding({ focus: undefined, today: TODAY })).toBe('none');
    expect(focusStanding({ focus: '2026-10-29', today: TODAY })).toBe('none');
  });
});

describe('focusChange', () => {
  it('sets focus to today to choose or keep, and takes it out to unchoose or drop', () => {
    expect(focusChange({ choice: 'choose', today: TODAY })).toEqual({ focus: TODAY });
    expect(focusChange({ choice: 'keep', today: TODAY })).toEqual({ focus: TODAY });
    expect(focusChange({ choice: 'unchoose', today: TODAY })).toEqual({ focus: null });
    expect(focusChange({ choice: 'drop', today: TODAY })).toEqual({ focus: null });
  });
});

describe('declaresFocus', () => {
  const typeWith = (properties: PropertyDef[]): ObjectType => ({
    name: 'task',
    label: 'Task',
    properties,
  });

  it('says yes only for a Task type with focus as a date', () => {
    expect(FOCUS_PROPERTY).toMatchObject({ key: 'focus', kind: 'date' });
    expect(declaresFocus(typeWith([FOCUS_PROPERTY]))).toBe(true);
    expect(declaresFocus(typeWith([{ ...FOCUS_PROPERTY, kind: 'text' }]))).toBe(false);
    expect(declaresFocus(typeWith([]))).toBe(false);
    expect(declaresFocus(null)).toBe(false);
  });
});

describe('todayLists, with tasks chosen for today', () => {
  it('leads with Chosen for today, then Carried over', () => {
    const sections = todayLists({ tasks: [], projects: [], at: AT }).sections;
    expect(sections.slice(0, 2).map((section) => section.id)).toEqual(['chosen', 'carriedOver']);
  });

  it('lists a task chosen for today under Chosen alone, whatever its open status', () => {
    const open = GTD_STATUSES.filter((status) => status !== 'archive');
    const tasks = open.map((status) => task(`Chosen ${status}`, { status, focus: TODAY }));
    expect(new Set(Object.values(placed(tasks)))).toEqual(new Set(['chosen']));
    expect(Object.keys(placed(tasks))).toHaveLength(open.length);
  });

  it('claims an overdue chosen task before Overdue does', () => {
    const late = task('Renew the licence', { due: '2026-10-01', focus: TODAY });
    expect(placed([late])).toEqual({ 'Renew the licence': 'chosen' });
  });

  it('lists yesterday’s choice, still open, under Carried over', () => {
    const tasks = [
      task('Call the printer', { focus: YESTERDAY, status: 'in-progress' }),
      task('Book the hall', { focus: TODAY }),
    ];
    expect(placed(tasks)).toEqual({
      'Call the printer': 'carriedOver',
      'Book the hall': 'chosen',
    });
  });

  it('lists a task chosen for a later day where it would be otherwise', () => {
    expect(placed([task('Plan the offsite', { focus: '2026-11-02' })])).toEqual({
      'Plan the offsite': 'nextActions',
    });
  });

  it('lists a task with no focus read, or a finished or deferred chosen one, in no chosen section', () => {
    const unread: ReviewTask = Object.fromEntries(
      Object.entries(task('Sort the post')).filter(([key]) => key !== 'focus'),
    ) as unknown as ReviewTask;
    expect(placed([unread])).toEqual({ 'Sort the post': 'nextActions' });
    const finished = task('Sent the figures', { status: 'archive', focus: TODAY });
    const putOff = task('Weed the beds', { focus: TODAY, defer: '2026-10-30' });
    expect(placed([finished, putOff])).toEqual({});
  });

  it('orders Chosen by due day, then title, and Carried over by the most recent choice', () => {
    const tasks = [
      task('Zest the lemons', { focus: TODAY }),
      task('Answer Mara', { focus: TODAY }),
      task('Mail the forms', { focus: TODAY, due: '2026-10-29' }),
      task('Older choice', { focus: '2026-10-20' }),
      task('Recent choice', { focus: YESTERDAY }),
      task('Also recent', { focus: YESTERDAY }),
    ];
    expect(titlesIn(tasks, 'chosen')).toEqual(['Mail the forms', 'Answer Mara', 'Zest the lemons']);
    expect(titlesIn(tasks, 'carriedOver')).toEqual([
      'Also recent',
      'Recent choice',
      'Older choice',
    ]);
  });

  it('puts the chosen rows first in the order focus moves through', () => {
    const tasks = [task('Next one'), task('Chosen one', { focus: TODAY })];
    const order = todayRowOrder(todayLists({ tasks, projects: [], at: AT }));
    expect(order).toEqual(['Tasks/Chosen one.md', 'Tasks/Next one.md']);
  });
});

describe('todayLists, against a focus that is not a choice (#108 fix round)', () => {
  it('lists a task whose focus is the person’s own where it would be otherwise, even with a day in it', () => {
    const own = task('Write the chapter', { focus: TODAY, focusIsOwn: true });
    expect(placed([own])).toEqual({ 'Write the chapter': 'nextActions' });
  });

  it('lists nothing as chosen or carried over in a vault that does not choose', () => {
    const tasks = [task('Today one', { focus: TODAY }), task('Old one', { focus: YESTERDAY })];
    const lists = todayLists({ tasks, projects: [], at: AT, choosing: false });
    const where = Object.fromEntries(
      lists.sections.flatMap((section) =>
        section.groups.flatMap((group) => group.tasks.map((each) => [each.title, section.id])),
      ),
    );
    expect(where).toEqual({ 'Today one': 'nextActions', 'Old one': 'nextActions' });
  });

  it('says the later day a task was chosen for, and no day for the rest', () => {
    const tasks = [
      task('Plan the offsite', { focus: '2026-11-02' }),
      task('Book the hall', { focus: TODAY }),
      task('Older choice', { focus: YESTERDAY }),
      task('Not chosen'),
    ];
    const later = Object.fromEntries(
      todayLists({ tasks, projects: [], at: AT }).sections.flatMap((section) =>
        section.groups.flatMap((group) =>
          group.tasks.map((each) => [each.title, each.laterChoice]),
        ),
      ),
    );
    expect(later).toEqual({
      'Plan the offsite': '2026-11-02',
      'Book the hall': null,
      'Older choice': null,
      'Not chosen': null,
    });
  });
});
