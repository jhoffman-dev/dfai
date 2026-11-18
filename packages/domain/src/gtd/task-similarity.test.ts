import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import {
  DUPLICATE_TASKS_PER_ITEM,
  possibleDuplicateTasks,
  titleLikeness,
  titleWords,
  TITLE_WORDS_MAX,
  type TaskCandidate,
} from './task-similarity.ts';

/**
 * #906: the title rule lists the tasks an Inbox task may copy, with why. It
 * never decides; Claude and the plan do.
 */

const PAYROLL = createVaultPath('Projects/Larkspur Payroll.md');
const HIRING = createVaultPath('Areas/Hiring.md');

const task = (title: string, extra: Partial<TaskCandidate> = {}): TaskCandidate => ({
  path: createVaultPath(`Tasks/${title}.md`),
  title,
  project: null,
  status: 'next-action',
  due: null,
  recurrence: null,
  waitingOn: '',
  dueUnread: false,
  defer: null,
  contexts: [],
  people: [],
  ...extra,
});
const ITEM = {
  path: createVaultPath('Inbox/Renew Larkspur Payroll contract.md'),
  title: 'Renew Larkspur Payroll contract',
  project: null as VaultPath | null,
};
const listed = (tasks: TaskCandidate[], item = ITEM) =>
  possibleDuplicateTasks({ item, tasks }).map((each) => [each.task.title, each.likeness]);

describe('titleWords', () => {
  it('folds case, drops punctuation, spacing and filler', () => {
    expect(titleWords('  Fwd: PLEASE renew the Larkspur-Payroll   contract!! ')).toEqual([
      'renew',
      'larkspur',
      'payroll',
      'contract',
    ]);
  });

  it('keeps letters of any script and digits', () => {
    expect(titleWords('Café Q4 review')).toEqual(['café', 'q4', 'review']);
  });
});

describe('titleLikeness', () => {
  it('keeps the words that can change what a task is (#907)', () => {
    expect(titleLikeness('Move to Tobias', 'Move Tobias')).toBeNull();
    expect(titleLikeness('Re-sign the lease', 'Sign the lease')).toBeNull();
    // Listed at most as a title within a longer one: a question, never a plan.
    expect(titleLikeness('Remember Mara’s birthday', 'Mara’s birthday')).toBe('contained');
  });

  it('lists the same words in another order as no more than same-words (#907)', () => {
    expect(titleLikeness('Pay Mara for Tobias', 'Pay Tobias for Mara')).toBe('same-words');
    expect(titleLikeness('Pay rent 1/12', 'Pay rent 12/1')).toBe('same-words');
    expect(titleLikeness('Call Mara', 'Call Mara Mara')).toBe('same-words');
  });

  it('compares at most the first words of a title, folding each title once', () => {
    const long = Array.from({ length: 10_000 }, (_, at) => `word${at}`).join(' ');
    expect(titleWords(long)).toHaveLength(TITLE_WORDS_MAX);
    // Past the cap is unread: two such titles are at most one within the other (#907).
    expect(titleLikeness(long, `${long} and more`)).toBe('contained');
    expect(titleLikeness(long, long)).toBe('contained');
  });

  it.each([
    ['Renew Larkspur Payroll contract', 'renew larkspur payroll contract.', 'same-title'],
    ['TODO: renew the Larkspur Payroll contract', 'Renew Larkspur Payroll contract', 'same-title'],
    ['Payroll contract: renew Larkspur', 'Renew Larkspur Payroll contract', 'same-words'],
    ['Renew Larkspur Payroll contract', 'Renew Larkspur Payroll contract with Mara', 'contained'],
  ] as const)('lists %j and %j as %s', (left, right, likeness) => {
    expect(titleLikeness(left, right)).toBe(likeness);
    expect(titleLikeness(right, left)).toBe(likeness);
  });

  it.each([
    ['Call Mara', 'Call Mara about payroll'],
    ['Renew Larkspur Payroll contract', 'Cancel Larkspur Payroll contract'],
    ['The', 'A'],
    ['', 'Renew'],
  ])('does not list %j and %j', (left, right) => {
    expect(titleLikeness(left, right)).toBeNull();
  });
});

describe('possibleDuplicateTasks', () => {
  it('lists the surest first, then by path, at most a few', () => {
    const tasks = [
      task('Renew Larkspur Payroll contract with Mara'),
      task('Payroll contract renew Larkspur'),
      task('renew larkspur payroll contract'),
      task('Renew the Larkspur Payroll contract'),
      task('Water the plants'),
    ];
    expect(listed(tasks)).toEqual([
      ['Renew the Larkspur Payroll contract', 'same-title'],
      ['renew larkspur payroll contract', 'same-title'],
      ['Payroll contract renew Larkspur', 'same-words'],
    ]);
    expect(DUPLICATE_TASKS_PER_ITEM).toBe(3);
  });

  it('never lists the item itself', () => {
    expect(listed([{ ...task(ITEM.title), path: ITEM.path }])).toEqual([]);
  });

  it('never lists a finished task, or one in the Archive', () => {
    expect(listed([task(ITEM.title, { status: 'archive' })])).toEqual([]);
    expect(
      listed([{ ...task(ITEM.title), path: createVaultPath('Archive/Tasks/Renew.md') }]),
    ).toEqual([]);
  });

  it('lists a task under the same project, or where either has none, never under another', () => {
    const item = { ...ITEM, project: PAYROLL };
    expect(listed([task(ITEM.title, { project: PAYROLL })], item)).toHaveLength(1);
    expect(listed([task(ITEM.title, { project: null })], item)).toHaveLength(1);
    expect(listed([task(ITEM.title, { project: HIRING })], item)).toEqual([]);
    expect(listed([task(ITEM.title, { project: HIRING })], ITEM)).toHaveLength(1);
  });
});

describe('the title rule, over seeded titles (#906)', () => {
  /** mulberry32: every run walks the same cases. */
  const seeded = (seed: number) => {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const WORDS = [
    'Renew',
    'the',
    'Larkspur',
    'payroll',
    'contract',
    'Call',
    'Mara',
    'Re:',
    '!',
    'please',
  ];
  const title = (rng: () => number) =>
    Array.from(
      { length: 1 + Math.floor(rng() * 5) },
      () => WORDS[Math.floor(rng() * WORDS.length)]!,
    ).join(rng() < 0.5 ? ' ' : '  ');

  it('is symmetric, never lists the item, nor anything outside the listing (2,000 cases)', () => {
    const rng = seeded(906);
    for (let n = 0; n < 2_000; n += 1) {
      const tasks = Array.from({ length: 6 }, (_, at) =>
        task(title(rng), {
          path: createVaultPath(`Tasks/${n}-${at}.md`),
          project: rng() < 0.3 ? PAYROLL : rng() < 0.5 ? HIRING : null,
          status: rng() < 0.2 ? 'archive' : 'next-action',
        }),
      );
      const self = tasks[0]!;
      const label = JSON.stringify(tasks.map((each) => each.title));
      for (const other of tasks) {
        expect(titleLikeness(self.title, other.title), label).toBe(
          titleLikeness(other.title, self.title),
        );
      }
      const found = possibleDuplicateTasks({ item: self, tasks });
      expect(found.length, label).toBeLessThanOrEqual(DUPLICATE_TASKS_PER_ITEM);
      for (const { task: listedTask } of found) {
        expect(listedTask.path, label).not.toBe(self.path);
        expect(tasks, label).toContain(listedTask);
        expect(listedTask.status, label).not.toBe('archive');
      }
    }
  });
});
