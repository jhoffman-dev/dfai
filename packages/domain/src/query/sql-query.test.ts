import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { matchingCommands } from '../index/palette-commands.ts';
import {
  isSavedView,
  parseSavedView,
  parseSqlView,
  sqlLayoutProblem,
  sqlViewFrontmatter,
} from './saved-view.ts';
import {
  normaliseSql,
  schemaFromResult,
  SCHEMA_SQL,
  sortResultRows,
  sqlProblem,
} from './sql-query.ts';

describe('a statement to run', () => {
  it('is trimmed of space and the semicolons that end it', () => {
    expect(normaliseSql('  SELECT 1 ;; \n')).toBe('SELECT 1');
    expect(normaliseSql("SELECT ';' AS semi")).toBe("SELECT ';' AS semi");
  });

  it('asks for something to run when there is nothing', () => {
    expect(sqlProblem(' ; ')).toBe('Write a query to run.');
    expect(sqlProblem('SELECT 1')).toBeNull();
  });
});

describe('a SQL view', () => {
  it('is written as a view with its statement and layout', () => {
    const note = sqlViewFrontmatter({ sql: 'SELECT path, title FROM v_task;', layout: 'list' });
    expect(note).toEqual({ atlas: 'view', layout: 'list', sql: 'SELECT path, title FROM v_task' });
    expect(isSavedView(note)).toBe(true);
    expect(parseSqlView(note)).toBe('SELECT path, title FROM v_task');
  });

  it('runs its statement, not a type, even when it names one', () => {
    const note = { atlas: 'view', type: 'task', sql: 'SELECT 1' };
    expect(parseSqlView(note)).toBe('SELECT 1');
    expect(parseSavedView(note)).toBeNull();
  });

  it('is not one without a statement, or without being a view', () => {
    expect(parseSqlView({ atlas: 'view', type: 'task', sql: '  ' })).toBeNull();
    expect(parseSavedView({ atlas: 'view', type: 'task', sql: '  ' })?.type).toBe('task');
    expect(parseSqlView({ sql: 'SELECT 1' })).toBeNull();
  });

  it('draws as a table always, and as a list only when its rows name notes', () => {
    expect(sqlLayoutProblem('table', ['n'])).toBeNull();
    expect(sqlLayoutProblem('list', ['n'])).toMatch(/path and title/);
    expect(sqlLayoutProblem('list', ['path', 'title'])).toBeNull();
    expect(sqlLayoutProblem('board', ['path', 'title'])).toMatch(/table or a list/);
  });
});

describe('the index’s schema', () => {
  /** A stand-in for the index: its tables, a type's view, and FTS5's shadow tables. */
  function index() {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE VIEW v_task AS SELECT path, title, 'x' AS status FROM files;
      CREATE VIRTUAL TABLE fts USING fts5(path, title, body, tokenize = 'unicode61 remove_diacritics 2');
    `);
    return database;
  }

  it('lists views first, then tables, with their columns, and no SQLite or FTS machinery', () => {
    const database = index();
    const rows = database.prepare(SCHEMA_SQL).all() as Record<string, unknown>[];
    const columns = ['table', 'kind', 'column'];
    const schema = schemaFromResult({
      columns,
      rows: rows.map((row) => columns.map((c) => row[c])),
    });
    expect(schema).toEqual([
      { name: 'v_task', kind: 'view', columns: ['path', 'title', 'status'] },
      { name: 'files', kind: 'table', columns: ['path', 'title'] },
      { name: 'fts', kind: 'table', columns: ['path', 'title', 'body'] },
    ]);
  });

  it('is empty when the result is not the schema statement’s', () => {
    expect(schemaFromResult({ columns: ['x'], rows: [['y']] })).toEqual([]);
  });
});

describe('sorting a result by its own columns', () => {
  const result = {
    columns: ['name', 'n'],
    rows: [
      ['b', 10],
      ['a', null],
      ['c', 9],
      ['a2', 2],
    ],
  };

  it('compares numbers as numbers, and keeps blanks last either way', () => {
    expect(sortResultRows(result, [{ key: 'n', direction: 'asc' }]).map((row) => row[0])).toEqual([
      'a2',
      'c',
      'b',
      'a',
    ]);
    expect(sortResultRows(result, [{ key: 'n', direction: 'desc' }]).map((row) => row[0])).toEqual([
      'b',
      'c',
      'a2',
      'a',
    ]);
  });

  it('leaves the order alone for no sort, or a column the result does not have', () => {
    expect(sortResultRows(result, [])).toEqual(result.rows);
    expect(sortResultRows(result, [{ key: 'missing', direction: 'asc' }])).toEqual(result.rows);
  });
});

describe('palette commands', () => {
  const commands = [
    { id: 'q', label: 'New query', keywords: ['sql'] },
    { id: 'v', label: 'New view' },
  ];

  it('offers a command once every word typed is in its name or its keywords', () => {
    expect(matchingCommands('new', commands).map((c) => c.id)).toEqual(['q', 'v']);
    expect(matchingCommands('NEW Q', commands).map((c) => c.id)).toEqual(['q']);
    expect(matchingCommands('sql', commands).map((c) => c.id)).toEqual(['q']);
    expect(matchingCommands('new board', commands)).toEqual([]);
  });

  it('offers nothing to an empty palette', () => {
    expect(matchingCommands('   ', commands)).toEqual([]);
  });
});
