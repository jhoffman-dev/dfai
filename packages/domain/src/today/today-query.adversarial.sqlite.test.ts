import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import {
  compileReviewProjectsQuery,
  compileReviewTasksQuery,
  reviewProject,
  reviewTask,
} from '../review/review-query.ts';
import type { ReviewTask } from '../review/weekly-review.ts';
import { countedWork } from '../testing/counted-work.ts';
import { correlatedReads } from '../testing/query-plan.ts';
import { todayLists } from './today-lists.ts';

/**
 * Adversarial pass on #111 (Today page): the page's two statements run
 * against the index as the host makes it — the same tables and the same
 * indexes (`apps/desktop/src-tauri/src/index_schema.sql`), which never runs ANALYZE.
 * The page asks them again after every change to a file while it is open, its
 * own row actions included, so what they cost is paid on every tick.
 */
/** The index's tables and indexes, from the file the host makes them from (#134). */
const HOST_SCHEMA = readFileSync(
  new URL('../../../../apps/desktop/src-tauri/src/index_schema.sql', import.meta.url),
  'utf8',
);

function hostIndex() {
  const database = new DatabaseSync(':memory:');
  database.exec(HOST_SCHEMA);
  return database;
}

const TODAY = '2026-10-12';
const NOW = Date.UTC(2026, 9, 12, 16);
const STATUSES = ['next-action', 'in-progress', 'waiting', 'backlog', 'someday', 'inbox'];
const PROJECTS = 100;

/** A vault of `tasks` open tasks, as many other notes, and a hundred projects. */
function fill(database: DatabaseSync, tasks: number): void {
  const file = database.prepare(
    'INSERT INTO files (path, title, modified, size) VALUES (?, ?, ?, 0)',
  );
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text, value_date) VALUES (?, ?, ?, ?, ?)',
  );
  const relation = database.prepare('INSERT INTO relations VALUES (?, ?, 0, ?, ?, ?)');
  database.exec('BEGIN');
  for (let at = 0; at < PROJECTS; at += 1) {
    const path = `Projects/Project ${at}.md`;
    file.run(path, `Project ${at}`, NOW);
    prop.run(path, 'type', 0, 'project', null);
    prop.run(path, 'status', 0, 'active', null);
  }
  for (let at = 0; at < tasks; at += 1) {
    const path = `Tasks/Task ${at}.md`;
    const day = `2026-10-${String(1 + (at % 28)).padStart(2, '0')}`;
    file.run(path, `Task ${at}`, NOW - (at % 40) * 86_400_000);
    prop.run(path, 'type', 0, 'task', null);
    prop.run(path, 'status', 0, STATUSES[at % STATUSES.length] ?? null, null);
    if (at % 3 === 0) prop.run(path, 'due', 0, day, day);
    if (at % 5 === 0) prop.run(path, 'defer', 0, day, day);
    prop.run(path, 'waiting_on', 0, at % 2 === 0 ? 'Mara Quill' : 'Tobias Fenn', null);
    prop.run(path, 'contexts', 0, '@office', null);
    prop.run(path, 'contexts', 1, '@calls', null);
    prop.run(path, 'estimate', 0, '30', null);
    const project = `Projects/Project ${at % PROJECTS}.md`;
    if (at % 4 !== 0) relation.run(path, 'project', `Project ${at % PROJECTS}`, '', project);

    const other = `Notes/Note ${at}.md`;
    file.run(other, `Note ${at}`, NOW);
    prop.run(other, 'type', 0, at % 2 === 0 ? 'meeting' : 'note', null);
    prop.run(other, 'status', 0, 'final', null);
    prop.run(other, 'due', 0, day, day);
  }
  database.exec('COMMIT');
}

/**
 * Measured at 5,000 open tasks on 2026-10-12 (a loaded Mac): 188,536 ms as
 * hosted against 67 ms once ANALYZE had run — every correlated read of `props`
 * goes by `props_key (key=?)`, all the rows of that key, for each task.
 */
const OPEN_TASKS = 1000;

describe('the Today page’s read on a vault of 1,000 open tasks', () => {
  it('reads each task’s own rows by its path, without statistics the index never gathers', () => {
    const database = hostIndex();
    fill(database, OPEN_TASKS);
    const tasks = compileReviewTasksQuery();
    const projects = compileReviewProjectsQuery();

    // As the host leaves it: no ANALYZE, so the planner guesses.
    expect(database.prepare(tasks.sql).all(...tasks.parameters)).toHaveLength(OPEN_TASKS);
    expect(database.prepare(projects.sql).all(...projects.parameters)).toHaveLength(PROJECTS);
    const reads = [tasks, projects].flatMap((statement) => correlatedReads(database, statement));
    expect(reads.length).toBeGreaterThan(0);
    // Each read is a seek that pins the note: by its path, or by type then path
    // through the host's props_type_fold, which the old inline copy here lacked.
    for (const read of reads) expect(read).toMatch(/ \((?:[^)]* AND )?(path|src|dst)=\?/);
  });

  it('sorts tasks into sections with work that grows with their number, not its square', () => {
    const tasksOfCount = (count: number): ReviewTask[] =>
      Array.from({ length: count }, (_, at) =>
        reviewTask({
          path: `Tasks/Task ${at}.md`,
          title: `Task ${at % 50}`,
          modified: NOW - (at % 40) * 86_400_000,
          status: STATUSES[at % STATUSES.length],
          due: at % 3 === 0 ? `2026-10-${String(1 + (at % 28)).padStart(2, '0')}` : null,
          defer: null,
          waitingOn: `Person ${at % 700}`,
          project: `Projects/Project ${at % 900}.md`,
          projectTitle: `Project ${at % 900}`,
        }),
      );
    const sorting = (tasks: ReviewTask[]) => () =>
      todayLists({ tasks, projects: [], at: { today: TODAY, now: NOW } });
    const many = tasksOfCount(5000);
    const page = sorting(many)();
    expect(page.sections.reduce((sum, section) => sum + section.count, 0)).toBeGreaterThan(2000);

    // Four times the tasks: sorting is some five times the work, a pass per task over the rest sixteen.
    const small = countedWork(sorting(tasksOfCount(1250)));
    const large = countedWork(sorting(many));
    expect(large).toBeLessThan(small * 8);
  });
});

/** The statement's reading of awkward frontmatter, through the index's own property rows. */
function tasksOf(notes: Readonly<Record<string, Readonly<Record<string, unknown>>>>) {
  const database = hostIndex();
  for (const [path, frontmatter] of Object.entries(notes)) {
    const title = path.replace(/^.*\//, '').replace(/\.md$/, '');
    database
      .prepare('INSERT INTO files (path, title, modified, size) VALUES (?, ?, ?, 0)')
      .run(path, title, NOW);
    for (const row of indexablePropertiesOf(frontmatter)) {
      database
        .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
  }
  const { sql, parameters } = compileReviewTasksQuery();
  const rows = database.prepare(sql).all(...parameters) as Parameters<typeof reviewTask>[0][];
  return rows.map(reviewTask);
}

function sectionsOf(notes: Readonly<Record<string, Readonly<Record<string, unknown>>>>) {
  const page = todayLists({
    tasks: tasksOf(notes),
    projects: [].map(reviewProject),
    at: { today: TODAY, now: NOW },
  });
  return Object.fromEntries(
    page.sections.map((section) => [
      section.id,
      section.groups.flatMap((group) => group.tasks.map((task) => task.title)),
    ]),
  );
}

describe('the Today page’s reading of dates and statuses as people write them', () => {
  it('reads a due day from a datetime, a list, and an offset as the day written', () => {
    const listed = sectionsOf({
      'Tasks/Timed.md': { type: 'task', status: 'next-action', due: `${TODAY}T23:59` },
      'Tasks/Offset.md': { type: 'task', status: 'next-action', due: `${TODAY}T00:30:00+09:00` },
      'Tasks/Listed.md': { type: 'task', status: 'backlog', due: [TODAY, '2026-12-01'] },
      'Tasks/Late list.md': { type: 'task', status: 'backlog', due: ['soon', '2026-10-01'] },
    });
    expect(listed['dueToday']).toEqual(['Listed', 'Offset', 'Timed']);
    expect(listed['overdue']).toEqual(['Late list']);
  });

  it('takes a date that is no date for no date: not overdue, not deferred, still listed', () => {
    const listed = sectionsOf({
      'Tasks/Vague.md': { type: 'task', status: 'next-action', due: 'next week', defer: 'later' },
      'Tasks/Impossible.md': { type: 'task', status: 'next-action', due: '2026-02-30' },
      'Tasks/Empty.md': { type: 'task', status: 'in-progress', due: '', defer: null },
      'Tasks/Far.md': { type: 'task', status: 'in-progress', due: '9999-12-31' },
      'Tasks/Ancient.md': { type: 'task', status: 'waiting', due: '1900-01-01', waiting_on: 'x' },
    });
    expect(listed['overdue']).toEqual(['Ancient']);
    expect(listed['dueToday']).toEqual([]);
    expect(listed['inProgress']).toEqual(['Far', 'Empty']);
    expect(listed['nextActions']).toEqual(['Impossible', 'Vague']);
  });

  it('lists no finished task, however Archive is spelled, and none of a status that is not one', () => {
    const listed = sectionsOf({
      'Tasks/Done.md': { type: 'task', status: 'archive', due: TODAY, defer: TODAY },
      'Tasks/Done list.md': { type: 'task', status: ['archive'], defer: TODAY },
      'Tasks/Done spaced.md': { type: 'Task ', status: ' archive ', defer: TODAY },
      'Tasks/Shouted.md': { type: 'task', status: 'ARCHIVE', due: '2026-10-01', defer: TODAY },
      'Tasks/Two.md': { type: 'task', status: ['next-action', 'archive'], defer: TODAY },
      'Tasks/Made up.md': { type: 'task', status: 'doing', due: '2026-10-01', defer: TODAY },
      'Tasks/None.md': { type: 'task', due: '2026-10-01', defer: TODAY },
      'Archive/Tasks/Old.md': { type: 'task', status: 'next-action', due: TODAY },
    });
    expect(Object.values(listed).flat()).toEqual([]);
  });

  it('keeps a Someday or Longterm task with a day out of Overdue and Due today', () => {
    const listed = sectionsOf({
      'Tasks/One day.md': { type: 'task', status: 'someday', due: '2026-10-01' },
      'Tasks/Far off.md': { type: 'task', status: 'longterm', due: TODAY },
    });
    expect(Object.values(listed).flat()).toEqual([]);
  });
});
