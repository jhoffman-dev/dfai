import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { isAtlasNote } from '../vault/vault-visibility.ts';
import { compileViewQuery, type ViewQuery } from './view-query.ts';

/**
 * The compiled SQL run for real, against SQLite, over a stand-in for the
 * index's `v_task` view: the rows a person sees are what is asserted, not the
 * text of the statement.
 */
function taskIndex(rows: readonly (readonly [string, string, string])[]) {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE v_task (path TEXT, title TEXT, summary TEXT, status TEXT)');
  const insert = database.prepare('INSERT INTO v_task VALUES (?, ?, ?, ?)');
  for (const [path, title, status] of rows) insert.run(path, title, '', status);
  return (query: ViewQuery, shape?: Parameters<typeof compileViewQuery>[1]) => {
    const { sql, parameters } = compileViewQuery(query, shape);
    return database.prepare(sql).all(...parameters);
  };
}

const tasks: ViewQuery = { type: 'task', columns: ['status'], filters: [], sorts: [], limit: 100 };

const run = taskIndex([
  ['tasks/P16-04.md', 'Views', 'doing'],
  ['tasks/P16-03.md', 'Page anatomy', 'done'],
  // A template is `type: task` so a new task can be made from it — it is not one.
  ['.atlas/templates/Task.md', 'Task', 'backlog'],
  ['.atlas/types/task.md', 'task', 'backlog'],
]);

describe('compileViewQuery, run against SQLite', () => {
  it('lists the notes of the type and leaves out what DFAI keeps in .atlas', () => {
    const paths = run(tasks).map((row) => row['path']);
    expect(paths).toEqual(['tasks/P16-03.md', 'tasks/P16-04.md']);
  });

  it('leaves them out of a filtered view too', () => {
    const rows = run({
      ...tasks,
      filters: [{ key: 'status', operator: 'is', value: 'backlog' }],
    });
    expect(rows).toEqual([]);
  });

  it('leaves them out of counts and groups, so a dashboard adds up the same', () => {
    expect(run(tasks, { aggregate: { kind: 'count', column: null } })).toEqual([{ value: 2 }]);
    const groups = run(tasks, { groupBy: 'status' }).map((row) => [row['label'], row['count']]);
    expect(groups).toEqual([
      ['doing', 1],
      ['done', 1],
    ]);
  });

  it('keeps a user folder that only starts with the same letters', () => {
    const withLookalike = taskIndex([['.atlas-notes/Mine.md', 'Mine', 'next']]);
    expect(withLookalike(tasks).map((row) => row['path'])).toEqual(['.atlas-notes/Mine.md']);
  });

  it('leaves out exactly the notes isAtlasNote calls DFAI’s own, so views and counts agree', () => {
    const paths = [
      '.atlas/templates/Tâche.md',
      '.atlas/😀.md',
      '.atlasx/Mine.md',
      '.ATLAS/Mine.md',
      'notes/.atlas/Mine.md',
      '.atlas.md',
      'atlas/Mine.md',
      '_atlas/Mine.md',
    ];
    const listed = taskIndex(paths.map((path) => [path, 'x', 'next'] as const))(tasks).map(
      (row) => row['path'],
    );
    expect([...listed].sort()).toEqual(paths.filter((path) => !isAtlasNote(path)).sort());
  });
});

describe('compileViewQuery and the Archive, run against SQLite', () => {
  const rows = [
    ['tasks/Live.md', 'Live', 'doing'],
    ['Archive/tasks/Done long ago.md', 'Done long ago', 'done'],
    ['archive/By hand.md', 'By hand', 'done'],
  ] as const;
  const withArchive = taskIndex(rows);

  it('leaves archived notes out of a view, its counts and its groups', () => {
    expect(withArchive(tasks).map((row) => row['path'])).toEqual(['tasks/Live.md']);
    expect(withArchive(tasks, { aggregate: { kind: 'count', column: null } })).toEqual([
      { value: 1 },
    ]);
    expect(withArchive(tasks, { groupBy: 'status' }).map((row) => row['label'])).toEqual(['doing']);
  });

  it('lists them too when the view is asked to include them', () => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE v_task (path TEXT, title TEXT, summary TEXT, status TEXT)');
    const insert = database.prepare('INSERT INTO v_task VALUES (?, ?, ?, ?)');
    for (const [path, title, status] of rows) insert.run(path, title, '', status);
    const { sql, parameters } = compileViewQuery(tasks, {}, { includeArchived: true });
    expect(
      database
        .prepare(sql)
        .all(...parameters)
        .map((row) => row['path']),
    ).toEqual(['Archive/tasks/Done long ago.md', 'archive/By hand.md', 'tasks/Live.md']);
  });
});

describe('a sort over a view, run against SQLite: blanks last either way (#913)', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE v_task (path TEXT, title TEXT, summary TEXT, priority REAL)');
  const insert = database.prepare('INSERT INTO v_task VALUES (?, ?, ?, ?)');
  for (const [path, priority] of [
    ['none.md', null],
    ['p3.md', 3],
    ['p1.md', 1],
    ['blank.md', ''],
    ['p4.md', 4],
    ['p2.md', 2],
  ] as const) {
    insert.run(path, path, '', priority);
  }
  const sorted = (direction: 'asc' | 'desc') => {
    const { sql, parameters } = compileViewQuery({
      ...tasks,
      columns: ['priority'],
      sorts: [{ key: 'priority', direction }],
    });
    return database
      .prepare(sql)
      .all(...parameters)
      .map((row) => row['path']);
  };

  it('lists P1 first and the tasks with no priority after P4, ascending', () => {
    expect(sorted('asc')).toEqual(['p1.md', 'p2.md', 'p3.md', 'p4.md', 'blank.md', 'none.md']);
  });

  it('keeps them last descending too, by path among themselves', () => {
    expect(sorted('desc')).toEqual(['p4.md', 'p3.md', 'p2.md', 'p1.md', 'blank.md', 'none.md']);
  });
});
