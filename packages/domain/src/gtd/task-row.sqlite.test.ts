import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { toBoardRows } from '../query/group-rows.ts';
import { compileAtlasQuery, resultFields } from '../query-language/compile.ts';
import { parseAtlasQuery } from '../query-language/parse.ts';
import { compileReviewTasksQuery, reviewTask } from '../review/review-query.ts';
import { taskAsRead } from '../today/row-read.ts';
import { TASK_TYPE_FILE } from './task-type.ts';
import { TASK_ROW_COLUMNS, taskRowState } from './task-row.ts';

/**
 * #107: a query of tasks, asked for its rows' task state, carries it in
 * hidden columns read from the index exactly as the Today page's statement
 * reads it — run here against SQLite over the index's own tables.
 */
const NOTES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'Tasks/Call Tobias.md': {
    type: 'task',
    status: 'next-action',
    due: '2026-11-02',
    focus: '2026-10-28',
    recurrence: 'every week',
  },
  'Tasks/Plan the garden.md': {
    type: 'task',
    status: 'someday',
    defer: '2026-12-01T09:00',
    focus: 'when the rain stops',
  },
  'Tasks/Two days.md': { type: 'task', status: [' waiting '], focus: ['2026-10-28', '2026-10-29'] },
  // A blank item is no item: this holds next-action (#616).
  'Tasks/With a blank.md': {
    type: 'task',
    status: ['next-action', ''],
    recurrence: ['', 'every day'],
  },
  // A nested list of two is two items, though both share their outer place: no one status.
  'Tasks/Nested.md': { type: 'task', status: [['next-action', 'waiting']] },
  'Projects/Larkspur.md': { type: 'project', status: 'next-action' },
};

function vaultIndex() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);`);
  for (const [path, frontmatter] of Object.entries(NOTES)) {
    const title = path.replace(/^.*\//, '').replace(/\.md$/, '');
    database.prepare('INSERT INTO files VALUES (?, ?, ?, ?, 1)').run(path, title, '', 1);
    for (const row of indexablePropertiesOf(frontmatter)) {
      database
        .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
  }
  const all = (sql: string, parameters: readonly (string | number)[]) =>
    database.prepare(sql).all(...parameters) as Record<string, unknown>[];
  const run = (text: string, taskRows: boolean) => {
    const compiled = compileAtlasQuery(parseAtlasQuery(text), {
      types: [TASK_TYPE_FILE.type, { name: 'project', label: 'Project', properties: [] }],
      resolveLink: () => null,
      taskRows,
    });
    const objects = all(compiled.sql, compiled.parameters);
    const columns = objects[0] === undefined ? [] : Object.keys(objects[0]);
    const rows = toBoardRows({
      columns,
      rows: objects.map((object) => columns.map((column) => object[column])),
    });
    return { compiled, columns, rows };
  };
  const review = () => {
    const statement = compileReviewTasksQuery();
    return all(statement.sql, statement.parameters).map(reviewTask);
  };
  return { run, review };
}

describe('a query of tasks asked for its rows’ task state (#107)', () => {
  it('carries each task’s state as Today’s statement reads it, without showing it', () => {
    const { run, review } = vaultIndex();
    const { compiled, rows } = run('FROM task SORT BY title SHOW status', true);
    expect(compiled.taskRows).toBe(true);
    // Not a column the result draws: only what SHOW names, and the type.
    expect(resultFields(compiled).map((field) => field.key)).toEqual(['type', 'status']);
    const read = new Map(review().map((task) => [String(task.path), task]));
    expect(rows.map((row) => row.title)).toEqual([
      'Call Tobias',
      'Nested',
      'Plan the garden',
      'Two days',
      'With a blank',
    ]);
    for (const row of rows) {
      const state = taskRowState(row.values);
      const today = read.get(row.path);
      expect(today, row.path).toBeDefined();
      expect(state).toEqual({
        asRead: {
          status: today?.status,
          due: today?.due,
          defer: today?.defer,
          focus: today?.focus,
        },
        focusIsOwn: today?.focusIsOwn,
        recurrence: today?.recurrence,
      });
      // And as the write reads the file, so a row is never refused as changed when it is not.
      expect(state?.asRead, row.path).toEqual(taskAsRead(NOTES[row.path] ?? {}));
    }
  });

  it('reads a blank item as no item, and a nested list of two as no one status', () => {
    const { rows } = vaultIndex().run('FROM task SORT BY title', true);
    const stateOf = (title: string) =>
      taskRowState(rows.find((row) => row.title === title)?.values ?? {});
    expect(stateOf('With a blank')).toMatchObject({
      asRead: { status: 'next-action' },
      recurrence: 'every day',
    });
    expect(stateOf('Nested')?.asRead.status).toBeNull();
  });

  it('reads the dates as days, a focus of words as the person’s own, and a list of two as theirs too', () => {
    const { rows } = vaultIndex().run('FROM task SORT BY title', true);
    const stateOf = (title: string) =>
      taskRowState(rows.find((row) => row.title === title)?.values ?? {});
    const [call, garden, two] = ['Call Tobias', 'Plan the garden', 'Two days'].map(stateOf);
    expect(call).toMatchObject({
      asRead: { status: 'next-action', due: '2026-11-02', focus: '2026-10-28' },
      focusIsOwn: false,
      recurrence: 'every week',
    });
    expect(garden).toMatchObject({
      asRead: { defer: '2026-12-01', focus: null },
      focusIsOwn: true,
    });
    expect(two).toMatchObject({ asRead: { status: 'waiting' }, focusIsOwn: true });
  });

  it('carries nothing unless asked, nor for a query of several types', () => {
    const { run } = vaultIndex();
    const unasked = run('FROM task SORT BY title', false);
    expect(unasked.compiled.taskRows).toBe(false);
    expect(unasked.columns.some((column) => column.startsWith('task:'))).toBe(false);
    const several = run('FROM task, project SORT BY title', true);
    expect(several.compiled.taskRows).toBe(false);
    expect(several.columns).not.toContain(TASK_ROW_COLUMNS.status);
    expect(several.rows).toHaveLength(6);
  });
});
