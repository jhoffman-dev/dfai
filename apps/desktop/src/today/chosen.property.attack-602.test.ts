/**
 * Attack on PR #602 (#108): a seeded walk over days of choosing, ticking,
 * deferring, moving and archiving tasks, each written through the app's own
 * write and markdown, then read back as the Today page reads it.
 */
import { describe, expect, it } from 'vitest';
import {
  addDays,
  createVaultPath,
  focusChange,
  gtdStatusOf,
  splitFrontmatter,
  taskAsRead,
  taskDeferral,
  todayLists,
  type ReviewTask,
  type TodayChoice,
  type TodaySectionId,
} from '@dfai/domain';
import {
  archiveTaskChange,
  fakeVaultFs,
  memoryVault,
  setNoteProperties,
  type PropertyChanges,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';

/** Mulberry32: the walk is the same for a seed, run after run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START = '2026-10-26';
const STATUSES = [
  'inbox',
  'next-action',
  'in-progress',
  'waiting',
  'backlog',
  'someday',
  'archive',
];

const shift = (day: string, days: number) => addDays(day, days) ?? day;

function taskText(random: () => number, n: number, today: string): string {
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
  const lines = ['type: task', `status: ${pick(STATUSES)}`];
  if (random() < 0.5) lines.push(`due: ${shift(today, pick([-3, -1, 0, 1, 4]))}`);
  if (random() < 0.3) lines.push(`defer: ${shift(today, pick([-2, 0, 2]))}`);
  if (random() < 0.3) lines.push('recurrence: every week');
  if (random() < 0.5) lines.push(`focus: ${shift(today, pick([-9, -1, 0, 1, 5]))}`);
  if (random() < 0.3) lines.push('contexts:\n  - "@home"   # where it is done');
  return ['---', ...lines, '---', '', `# Task ${n}`, ''].join('\n');
}

type Action =
  | { kind: TodayChoice }
  | { kind: 'tick' }
  | { kind: 'defer'; days: number }
  | { kind: 'move'; status: string };

const MAY_TOUCH: Readonly<Record<Action['kind'], readonly string[]>> = {
  choose: ['focus'],
  unchoose: ['focus'],
  keep: ['focus'],
  drop: ['focus'],
  // Finishing a task, or rolling a repeating one on, ends the day's choice (fix round of #602).
  tick: ['status', 'completed', 'lastCompleted', 'due', 'defer', 'focus'],
  defer: ['defer'],
  move: ['status', 'completed'],
};

function valuesOf(action: Action, today: string): PropertyChanges {
  switch (action.kind) {
    case 'tick':
      return archiveTaskChange();
    case 'defer':
      return taskDeferral({ today, days: action.days }) ?? {};
    case 'move':
      return { status: action.status };
    default:
      return focusChange({ choice: action.kind, today });
  }
}

const propertiesOf = (text: string) =>
  remarkMarkdown.frontmatterProperties(splitFrontmatter(text).frontmatter);

function asReviewTask(path: string, text: string): ReviewTask {
  const properties = propertiesOf(text);
  const read = taskAsRead(properties);
  return {
    path: createVaultPath(path),
    title: path,
    status: gtdStatusOf(properties['status']),
    due: read.due,
    defer: read.defer,
    focus: read.focus,
    waitingOn: '',
    contexts: [],
    project: null,
    projectTitle: null,
    modified: 0,
  };
}

function sectionsOf(files: ReadonlyMap<string, string>, today: string) {
  const tasks = [...files].filter(([path]) => path.startsWith('Tasks/'));
  const lists = todayLists({
    tasks: tasks.map(([path, text]) => asReviewTask(path, text)),
    projects: [],
    at: { today, now: Date.parse(`${today}T12:00:00Z`) },
  });
  const where = new Map<string, TodaySectionId[]>();
  for (const section of lists.sections) {
    for (const group of section.groups) {
      for (const task of group.tasks)
        where.set(task.path, [...(where.get(task.path) ?? []), section.id]);
    }
  }
  return where;
}

function changedKeys(before: string, after: string): string[] {
  const was = propertiesOf(before);
  const now = propertiesOf(after);
  return [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(
    (key) => JSON.stringify(was[key]) !== JSON.stringify(now[key]),
  );
}

async function walk(seed: number) {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
  let today = START;
  const initial = Object.fromEntries(
    Array.from({ length: 8 }, (_, n) => [`Tasks/Task ${n}.md`, taskText(random, n, today)]),
  );
  const memory = memoryVault(initial);
  const fs = fakeVaultFs(memory.fs);
  const problems: string[] = [];
  const actions: Action[] = [
    { kind: 'choose' },
    { kind: 'unchoose' },
    { kind: 'keep' },
    { kind: 'drop' },
    { kind: 'tick' },
    { kind: 'defer', days: 1 },
    { kind: 'move', status: 'someday' },
    { kind: 'move', status: 'next-action' },
    { kind: 'move', status: 'archive' },
  ];

  for (let step = 0; step < 40; step += 1) {
    if (random() < 0.15) {
      today = shift(today, 1);
    } else {
      const path = pick(Object.keys(initial));
      const action = pick(actions);
      const before = memory.files.get(path) ?? '';
      await setNoteProperties({
        fs,
        markdown: remarkMarkdown,
        path,
        values: valuesOf(action, today),
        today,
      });
      const after = memory.files.get(path) ?? '';
      const stray = changedKeys(before, after).filter(
        (key) =>
          !MAY_TOUCH[action.kind].includes(key) &&
          // A move into Archive finishes the task, which ends its choice too.
          !(action.kind === 'move' && action.status === 'archive' && key === 'focus'),
      );
      if (stray.length > 0)
        problems.push(`seed ${seed} step ${step}: ${action.kind} touched ${stray.join(', ')}`);
      if (action.kind === 'choose' && propertiesOf(before)['focus'] === undefined) {
        await setNoteProperties({
          fs,
          markdown: remarkMarkdown,
          path,
          values: focusChange({ choice: 'unchoose', today }),
          today,
        });
        if (memory.files.get(path) !== before) {
          problems.push(`seed ${seed} step ${step}: choose then unchoose changed ${path}`);
        }
        await setNoteProperties({
          fs,
          markdown: remarkMarkdown,
          path,
          values: valuesOf(action, today),
          today,
        });
      }
    }
    const where = sectionsOf(memory.files, today);
    for (const [path, text] of memory.files) {
      if (!path.startsWith('Tasks/')) continue;
      const task = asReviewTask(path, text);
      const sections = where.get(path) ?? [];
      const deferred = task.defer !== null && task.defer > today;
      const finished = task.status === 'archive';
      if (sections.length > 1)
        problems.push(`seed ${seed} step ${step}: ${path} in ${sections.join('+')}`);
      if ((deferred || finished) && sections.length > 0) {
        problems.push(
          `seed ${seed} step ${step}: ${path} ${finished ? 'finished' : 'deferred'} but in ${sections[0]}`,
        );
      }
      const chosen = !deferred && !finished && task.focus === today;
      if (chosen !== sections.includes('chosen')) {
        problems.push(
          `seed ${seed} step ${step}: ${path} chosen=${chosen} but sections ${sections.join('+')}`,
        );
      }
      const carried =
        !deferred &&
        !finished &&
        task.focus !== null &&
        task.focus !== undefined &&
        task.focus < today;
      if (carried !== sections.includes('carriedOver')) {
        problems.push(
          `seed ${seed} step ${step}: ${path} carried=${carried} but sections ${sections.join('+')}`,
        );
      }
    }
  }
  return problems;
}

describe('choosing for today over a seeded walk of days (#108)', () => {
  it('keeps every task in at most one section, finished and deferred ones in none, and Chosen exactly the open tasks focused today', async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 60; seed += 1) problems.push(...(await walk(seed)));
    expect(problems.slice(0, 10)).toEqual([]);
  }, 60_000);

  it('is the same walk for the same seed', async () => {
    expect(await walk(7)).toEqual(await walk(7));
  }, 60_000);
});
