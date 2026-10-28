import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { compileTypeCountsQuery, TYPE_COUNTS_QUERY_COLUMNS } from './type-counts-query.ts';

/**
 * The sidebar's count beside each type, run for real against SQLite over the
 * index's own `files` and `props` tables: what is asserted is the counts.
 */
function countsIn(
  notes: Readonly<Record<string, Readonly<Record<string, string | readonly string[]>>>>,
  typeNames: readonly string[],
): Record<string, number> {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
      value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
  `);
  const file = database.prepare('INSERT INTO files VALUES (?, ?)');
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text) VALUES (?, ?, ?, ?)',
  );
  for (const [path, frontmatter] of Object.entries(notes)) {
    file.run(path, path);
    for (const [key, value] of Object.entries(frontmatter)) {
      const values = typeof value === 'string' ? [value] : value;
      values.forEach((each, at) => prop.run(path, key, at, each));
    }
  }
  const { sql, parameters } = compileTypeCountsQuery(typeNames);
  const statement = database.prepare(sql);
  expect(statement.columns().map((column) => column.name)).toEqual([...TYPE_COUNTS_QUERY_COLUMNS]);
  const rows = statement.all(...parameters) as { type: string; count: number }[];
  return Object.fromEntries(rows.map((row) => [row.type, row.count]));
}

describe('compileTypeCountsQuery', () => {
  // Follow-up to #110: counted in any case and spacing, as FROM finds a type, under its folded name.
  it('counts a note whose type is written in capitals or with spaces, once, under the folded name', () => {
    expect(
      countsIn(
        {
          'tasks/a.md': { type: 'task' },
          'tasks/b.md': { type: 'Task' },
          'tasks/c.md': { type: [' TASK ', 'task'] },
          'tasks/d.md': { type: 'tasks' },
        },
        ['Task'],
      ),
    ).toEqual({ task: 3 });
  });

  it('counts the notes of each type asked for, in one row per type, and no other type', () => {
    expect(
      countsIn(
        {
          'tasks/a.md': { type: 'task' },
          'tasks/b.md': { type: 'task' },
          'people/c.md': { type: 'person' },
          'notes/d.md': { type: 'meeting' },
          'notes/e.md': {},
        },
        ['task', 'person'],
      ),
    ).toEqual({ task: 2, person: 1 });
  });

  it('leaves a type with no notes out, for the caller to count as none', () => {
    expect(countsIn({ 'tasks/a.md': { type: 'task' } }, ['task', 'person'])).toEqual({ task: 1 });
  });

  it('does not count the templates and definitions DFAI keeps in .atlas, but does a note in a folder named like it', () => {
    expect(
      countsIn(
        {
          'tasks/P16-04.md': { type: 'task' },
          '.atlas/templates/Task.md': { type: 'task' },
          '.atlas-notes/Mine.md': { type: 'task' },
        },
        ['task'],
      ),
    ).toEqual({ task: 2 });
  });

  it('does not count a note in the Archive, however the folder is spelled, but does one in a folder of that name further down', () => {
    expect(
      countsIn(
        {
          'tasks/Live.md': { type: 'task' },
          'Archive/tasks/Old.md': { type: 'task' },
          'archive/tasks/Older.md': { type: 'task' },
          'tasks/Archive/Kept.md': { type: 'task' },
        },
        ['task'],
      ),
    ).toEqual({ task: 2 });
  });

  it('does not count a Project set to PARA archive, though its file has not moved (#213)', () => {
    expect(
      countsIn(
        {
          'DFAI.md': { type: 'project' },
          'Garden.md': { type: 'project', para: 'area' },
          'Old Plan.md': { type: 'project', para: ' Archive ' },
        },
        ['project'],
      ),
    ).toEqual({ project: 2 });
  });

  it('reads a Project’s PARA from its first value, as the picker does, when it lists more than one', () => {
    expect(
      countsIn(
        {
          'Garden.md': { type: 'project', para: ['project', 'archive'] },
          'Shed.md': { type: 'project', para: ['archive', 'project'] },
        },
        ['project'],
      ),
    ).toEqual({ project: 1 });
  });

  it('still counts a note that is a task as well as a Project set to archive, as a task', () => {
    expect(
      countsIn({ 'Both.md': { type: ['task', 'project'], para: 'archive' } }, ['task', 'project']),
    ).toEqual({ task: 1 });
  });

  it('counts a note of another type that says para: archive, which only a Project can be', () => {
    expect(countsIn({ 'Old.md': { type: 'task', para: 'archive' } }, ['task'])).toEqual({
      task: 1,
    });
  });

  it('counts a note once under each type it declares, and once for a type it declares twice', () => {
    expect(
      countsIn({ 'Both.md': { type: ['task', 'person', 'task'] } }, ['task', 'person']),
    ).toEqual({ task: 1, person: 1 });
  });

  it('binds the type names, so a name with a quote in it is only a name', () => {
    expect(countsIn({ "O'Neil.md": { type: "o'neil" } }, ["o'neil"])).toEqual({ "o'neil": 1 });
  });
});
