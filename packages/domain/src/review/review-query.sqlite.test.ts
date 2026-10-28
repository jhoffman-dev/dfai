import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { focusIsOwn } from '../today/row-read.ts';
import {
  compileReviewDoneQuery,
  compileReviewMeetingsQuery,
  compileReviewProjectsQuery,
  compileReviewTasksQuery,
  reviewProject,
  reviewSource,
  reviewTask,
} from './review-query.ts';

/**
 * P30-07: the review's statements run for real against SQLite, over the
 * index's own `files`, `props` and `relations` tables.
 */
interface Fixture {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly modified?: number;
  /** Each relation the note holds: key, the target as written, and the note it resolved to. */
  readonly relations?: readonly { key: string; name: string; dst: string | null }[];
}

function indexOf(notes: Readonly<Record<string, Fixture>>) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);`);
  for (const [path, note] of Object.entries(notes)) {
    const title = path.replace(/^.*\//, '').replace(/\.md$/, '');
    database
      .prepare('INSERT INTO files VALUES (?, ?, ?, ?, 0)')
      .run(path, title, '', note.modified ?? 1);
    for (const row of indexablePropertiesOf(note.frontmatter)) {
      database
        .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
    (note.relations ?? []).forEach((relation, at) =>
      database
        .prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)')
        .run(path, relation.key, at, relation.name, relation.name.toLowerCase(), relation.dst),
    );
  }
  return database;
}

function tasksOf(notes: Readonly<Record<string, Fixture>>) {
  const { sql, parameters } = compileReviewTasksQuery();
  const rows = indexOf(notes)
    .prepare(sql)
    .all(...parameters) as Parameters<typeof reviewTask>[0][];
  return rows.map(reviewTask);
}

function projectsOf(notes: Readonly<Record<string, Fixture>>) {
  const { sql, parameters } = compileReviewProjectsQuery();
  const rows = indexOf(notes)
    .prepare(sql)
    .all(...parameters) as Parameters<typeof reviewProject>[0][];
  return rows.map(reviewProject);
}

describe('compileReviewTasksQuery', () => {
  it('reads a task whole: status, days, who it waits on, its project, and when it changed', () => {
    const tasks = tasksOf({
      'Tasks/Quote.md': {
        frontmatter: {
          type: 'Task',
          status: ' waiting',
          due: '2026-10-01T09:00',
          defer: '2026-10-20',
          focus: '2026-10-14T08:00',
          waiting_on: ['[[Mara Quill]]', '[[Tobias Fenn]]'],
          contexts: ['@office', ' @calls ', ''],
          project: '[[Atlas]]',
        },
        modified: 1234,
        relations: [
          { key: 'waiting_on', name: 'Mara Quill', dst: 'People/Mara Quill.md' },
          { key: 'waiting_on', name: 'Tobias Fenn', dst: null },
          { key: 'project', name: 'Atlas', dst: 'Projects/Atlas.md' },
        ],
      },
      'Projects/Atlas.md': { frontmatter: { type: 'project', title: 'ignored' } },
    });
    expect(tasks).toEqual([
      {
        path: 'Tasks/Quote.md',
        title: 'Quote',
        status: 'waiting',
        due: '2026-10-01',
        focus: '2026-10-14',
        defer: '2026-10-20',
        recurrence: null,
        waitingOn: 'Mara Quill, Tobias Fenn',
        contexts: ['@office', '@calls'],
        project: 'Projects/Atlas.md',
        projectTitle: 'Atlas',
        projectLinks: ['atlas'],
        modified: 1234,
      },
    ]);
  });

  it('reads how a task repeats, so finishing it can be drawn before it is written (#260)', () => {
    const [weekly] = tasksOf({
      'Tasks/Water.md': {
        frontmatter: { type: 'task', status: 'next-action', recurrence: 'weekly' },
      },
    });
    expect(weekly?.recurrence).toBe('weekly');
  });

  it('reads a task with nothing set as nothing, and a project link that names no note as none', () => {
    const [bare] = tasksOf({
      'Tasks/Bare.md': {
        frontmatter: { type: 'task', due: 'soon', status: ['next-action', 'waiting'] },
        relations: [{ key: 'project', name: 'Gone', dst: null }],
      },
    });
    expect(bare).toMatchObject({
      status: null,
      due: null,
      defer: null,
      waitingOn: '',
      contexts: [],
      project: null,
      projectTitle: null,
    });
  });

  it('reads a status GTD does not know as none, and the first day and the first project that resolve', () => {
    const [task] = tasksOf({
      'Tasks/Mixed.md': {
        frontmatter: { type: 'task', status: 'doing', due: ['soon', '2026-10-03'] },
        relations: [
          { key: 'project', name: 'Gone', dst: null },
          { key: 'project', name: 'Atlas', dst: 'Projects/Atlas.md' },
        ],
      },
    });
    expect(task).toMatchObject({ status: null, due: '2026-10-03', project: 'Projects/Atlas.md' });
  });

  it('reads the names a task’s project links by, each folded, resolved or not (#392)', () => {
    const [task, bare] = tasksOf({
      'Tasks/Mixed.md': {
        frontmatter: { type: 'task', status: 'next-action' },
        relations: [
          { key: 'project', name: 'Garden Plan', dst: null },
          { key: 'waiting_on', name: 'Mara Quill', dst: null },
          { key: 'project', name: 'Atlas', dst: 'Projects/Atlas.md' },
        ],
      },
      'Tasks/Unfiled.md': { frontmatter: { type: 'task', status: 'next-action' } },
    });
    expect(task?.projectLinks).toEqual(['garden plan', 'atlas']);
    expect(bare?.projectLinks).toEqual([]);
  });

  it('names a task’s project by its note’s title, and one context written alone as one', () => {
    const [task] = tasksOf({
      'Tasks/Call.md': {
        frontmatter: { type: 'task', status: 'next-action', contexts: '@phone' },
        relations: [
          { key: 'project', name: 'Gone', dst: null },
          { key: 'project', name: 'garden', dst: 'Areas/Home/Garden.md' },
        ],
      },
      'Areas/Home/Garden.md': { frontmatter: { type: 'project' } },
    });
    expect(task).toMatchObject({
      contexts: ['@phone'],
      project: 'Areas/Home/Garden.md',
      projectTitle: 'Garden',
    });
  });

  it('names who a task waits on whether it is a link or a plain name, mixed lists included', () => {
    const waiting = (waiting_on: unknown) =>
      tasksOf({ 'Tasks/W.md': { frontmatter: { type: 'task', status: 'waiting', waiting_on } } })[0]
        ?.waitingOn;
    expect(waiting('Tobias Fenn')).toBe('Tobias Fenn');
    expect(waiting('[[Mara Quill]]')).toBe('Mara Quill');
    expect(waiting('[[People/Mara Quill|Mara]]')).toBe('Mara');
    expect(waiting(['[[Mara Quill]]', 'Tobias Fenn', ' '])).toBe('Mara Quill, Tobias Fenn');
    expect(waiting([['Mara Quill']])).toBe('Mara Quill');
    expect(waiting('the bank, Larkspur Payroll')).toBe('the bank, Larkspur Payroll');
    // Kept whole by the index, and someone to the rules: never shown as nobody.
    expect(waiting({ person: 'Mara Quill' })).toContain('Mara Quill');
  });

  it('leaves out finished tasks, archived and hidden ones, templates, and notes of other types', () => {
    const tasks = tasksOf({
      'Tasks/Open.md': { frontmatter: { type: 'task', status: 'inbox' } },
      'Tasks/Finished.md': { frontmatter: { type: 'task', status: 'archive' } },
      'Archive/Tasks/Old.md': { frontmatter: { type: 'task', status: 'waiting' } },
      '.atlas/templates/Task.md': { frontmatter: { type: 'task', status: 'inbox' } },
      'Projects/Atlas.md': { frontmatter: { type: 'project', status: 'active' } },
    });
    expect(tasks.map((task) => task.path)).toEqual(['Tasks/Open.md']);
  });
});

describe('compileReviewProjectsQuery', () => {
  it('reads only the Project notes that are projects: not an area, a resource or one archived by PARA (#213)', () => {
    const paths = projectsOf({
      'Projects/Atlas.md': { frontmatter: { type: 'project' } },
      'Projects/Said.md': { frontmatter: { type: 'project', para: 'Project' } },
      'Projects/Odd.md': { frontmatter: { type: 'project', para: 'someday' } },
      'Garden.md': { frontmatter: { type: 'project', para: 'area' } },
      'Manual.md': { frontmatter: { type: 'project', para: 'resource' } },
      'Old.md': { frontmatter: { type: 'project', para: ' ARCHIVE ' } },
    }).map((project) => project.path);
    expect(paths.sort()).toEqual(['Projects/Atlas.md', 'Projects/Odd.md', 'Projects/Said.md']);
  });

  it('reads every project in use with its status, and nothing else', () => {
    expect(
      projectsOf({
        'Projects/Atlas.md': { frontmatter: { type: 'project', status: 'active ' } },
        'Projects/Quiet.md': { frontmatter: { type: 'Project', status: '' } },
        'Archive/Projects/Old.md': { frontmatter: { type: 'project', status: 'active' } },
        'Areas/Garden.md': { frontmatter: { type: 'area' } },
      }),
    ).toEqual([
      { path: 'Projects/Atlas.md', title: 'Atlas', status: 'active', moving: false },
      { path: 'Projects/Quiet.md', title: 'Quiet', status: null, moving: false },
    ]);
  });

  /** One active project, and a note filed under it, read back as whether the project is moving. */
  function movingWith(path: string, frontmatter: Readonly<Record<string, unknown>>) {
    const [project] = projectsOf({
      'Projects/Atlas.md': { frontmatter: { type: 'project', status: 'active' } },
      [path]: {
        frontmatter,
        relations: [{ key: 'project', name: 'Atlas', dst: 'Projects/Atlas.md' }],
      },
    });
    return project?.moving;
  }

  it('is moving with a task filed under it at Next Action or In Progress, deferred or not', () => {
    expect(movingWith('Tasks/T.md', { type: 'task', status: 'next-action' })).toBe(true);
    expect(movingWith('Tasks/T.md', { type: 'Task', status: 'in-progress' })).toBe(true);
    expect(
      movingWith('Tasks/T.md', { type: 'task', status: 'next-action', defer: '2027-01-01' }),
    ).toBe(true);
  });

  it('is not moving on any other status, a status list, or a note that is no task in use', () => {
    for (const status of ['inbox', 'backlog', 'waiting', 'someday', 'longterm', 'archive']) {
      expect(movingWith('Tasks/T.md', { type: 'task', status })).toBe(false);
    }
    for (const status of [
      ['next-action', 'waiting'],
      ['backlog', 'next-action'],
    ]) {
      expect(movingWith('Tasks/T.md', { type: 'task', status })).toBe(false);
    }
    expect(movingWith('Notes/N.md', { type: 'meeting', status: 'next-action' })).toBe(false);
    expect(movingWith('Archive/Tasks/T.md', { type: 'task', status: 'next-action' })).toBe(false);
    expect(movingWith('.atlas/templates/T.md', { type: 'task', status: 'next-action' })).toBe(
      false,
    );
  });

  it('is not moving on a task filed under another project', () => {
    const [atlas] = projectsOf({
      'Projects/Atlas.md': { frontmatter: { type: 'project', status: 'active' } },
      'Tasks/T.md': {
        frontmatter: { type: 'task', status: 'next-action' },
        relations: [{ key: 'project', name: 'Other', dst: 'Projects/Other.md' }],
      },
      'Tasks/U.md': {
        frontmatter: { type: 'task', status: 'next-action' },
        relations: [{ key: 'owner', name: 'Atlas', dst: 'Projects/Atlas.md' }],
      },
    });
    expect(atlas?.moving).toBe(false);
  });
});

describe('the Friday review draft’s statements (#40)', () => {
  const sourcesOf = (
    notes: Readonly<Record<string, Fixture>>,
    { sql, parameters }: { sql: string; parameters: readonly (string | number | null)[] },
  ) =>
    (
      indexOf(notes)
        .prepare(sql)
        .all(...parameters) as Record<string, unknown>[]
    ).map(reviewSource);

  it('reads the tasks finished since a moment, newest first, and no other', () => {
    const done = sourcesOf(
      {
        'Tasks/Shipped.md': { frontmatter: { type: 'task', status: 'archive' }, modified: 5_000 },
        'Tasks/Just now.md': { frontmatter: { type: 'Task', status: 'archive' }, modified: 9_000 },
        'Tasks/Long ago.md': { frontmatter: { type: 'task', status: 'archive' }, modified: 999 },
        'Tasks/Open.md': { frontmatter: { type: 'task', status: 'next-action' }, modified: 9_000 },
        'Notes/Done note.md': { frontmatter: { type: 'note', status: 'archive' }, modified: 9_000 },
        // Finished this week and already filed away: still one of the week's wins.
        'Archive/Tasks/Filed.md': {
          frontmatter: { type: 'task', status: 'archive' },
          modified: 7_000,
        },
        '.atlas/Tasks/Hidden.md': {
          frontmatter: { type: 'task', status: 'archive' },
          modified: 9_000,
        },
      },
      compileReviewDoneQuery(1_000),
    );
    expect(done).toEqual([
      { path: 'Tasks/Just now.md', title: 'Just now' },
      { path: 'Archive/Tasks/Filed.md', title: 'Filed' },
      { path: 'Tasks/Shipped.md', title: 'Shipped' },
    ]);
  });

  it('counts a task finished at the moment itself as finished since it', () => {
    const done = sourcesOf(
      { 'Tasks/Edge.md': { frontmatter: { type: 'task', status: 'archive' }, modified: 1_000 } },
      compileReviewDoneQuery(1_000),
    );
    expect(done.map(({ path }) => path)).toEqual(['Tasks/Edge.md']);
  });

  it('reads the meetings held from a day to today, by day, each with its day', () => {
    const meetings = sourcesOf(
      {
        'Meetings/Standup.md': { frontmatter: { type: 'meeting', date: '2026-10-21' } },
        'Meetings/Kickoff.md': { frontmatter: { type: 'Meeting', date: '2026-10-16T09:30' } },
        'Meetings/Old.md': { frontmatter: { type: 'meeting', date: '2026-10-15' } },
        'Meetings/Next week.md': { frontmatter: { type: 'meeting', date: '2026-10-26' } },
        'Meetings/Undated.md': { frontmatter: { type: 'meeting' } },
        'Notes/Dated.md': { frontmatter: { type: 'note', date: '2026-10-20' } },
      },
      compileReviewMeetingsQuery({ sinceDay: '2026-10-16', untilDay: '2026-10-23' }),
    );
    expect(meetings).toEqual([
      { path: 'Meetings/Kickoff.md', title: 'Kickoff', date: '2026-10-16' },
      { path: 'Meetings/Standup.md', title: 'Standup', date: '2026-10-21' },
    ]);
  });
});

describe('compileReviewTasksQuery, a focus that is the person’s own (#108)', () => {
  const VALUES: readonly unknown[] = [
    '2026-10-28',
    '2026-10-28T09:00',
    ['2026-10-28'],
    '',
    null,
    'writing',
    '2026-02-30',
    5,
    '[[Daily/2026-10-28]]',
    ['2026-10-28', '2026-10-01'],
    ['2026-10-28', 'writing'],
  ];

  it.each(VALUES.map((value) => [JSON.stringify(value), value]))(
    'reads focus %s as focusIsOwn reads the file',
    (_, focus) => {
      const frontmatter = { type: 'task', status: 'next-action', focus };
      const [read] = tasksOf({ 'Tasks/Paint.md': { frontmatter } });
      expect(read?.focusIsOwn ?? false).toBe(focusIsOwn(frontmatter));
    },
  );
});
