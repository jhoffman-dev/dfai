import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { compareDues, dueOf } from '../gtd/task-due.ts';
import { taskRowColumnsSql, TASK_ROW_COLUMNS } from '../gtd/task-row.ts';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { parseObjectType } from '../types/property-def.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';

/**
 * #928: a due with a time, through the query language, run against SQLite
 * over the index's tables. `value_date` holds the due as written, whose
 * first ten characters are its day, as it did before #928: so a date-only
 * vault answers every date query with the rows it always did, and a timed
 * due is due, late or this week by its day and sorts by its time within it.
 */
const TODAY = '2999-03-13';
const INDEX_TODAY = "date('now', 'localtime'";
const TYPES = [parseObjectType({ name: 'task', properties: { due: 'date', status: 'text' } })];

/** Date-only dues, as every vault held them before #928. */
const DATE_ONLY: Readonly<Record<string, string>> = {
  'Yesterday plain': '2999-03-12',
  'Today plain': '2999-03-13',
  'Today plain too': '2999-03-13',
  'In six days': '2999-03-19',
  'In a week': '2999-03-20',
};

/** The same days, some with a time, written as the app writes one or as a person might. */
const TIMED: Readonly<Record<string, string>> = {
  'Yesterday late': '2999-03-12T23:30',
  'Today at nine': '2999-03-13T09:00',
  'Today at five': '2999-03-13 17:00',
  'Today at noon': '2999-03-13T12:00',
  'In six days at eight': '2999-03-19T08:00',
};

function databaseOf(dues: Readonly<Record<string, string>>) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL, progress INTEGER);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
    CREATE TABLE links (src TEXT NOT NULL, dst TEXT, target TEXT NOT NULL, kind TEXT NOT NULL);`);
  const notes = { ...dues, 'No due': null };
  for (const [title, due] of Object.entries(notes)) {
    const path = `Tasks/${title}.md`;
    database.prepare('INSERT INTO files VALUES (?, ?, ?, 0, 1, NULL)').run(path, title, '');
    const frontmatter = { type: 'task', status: 'next-action', ...(due !== null && { due }) };
    for (const row of indexablePropertiesOf(frontmatter)) {
      database
        .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
  }
  return database;
}

function rowsOf(database: DatabaseSync, text: string) {
  const { sql, parameters } = compileAtlasQuery(parseAtlasQuery(text), {
    types: TYPES,
    resolveLink: () => null,
  });
  return database.prepare(sql.replaceAll(INDEX_TODAY, `date('${TODAY}'`)).all(...parameters);
}

const titles = (database: DatabaseSync, text: string) =>
  rowsOf(database, text).map((row) => row['title']);

const DUE_TODAY = 'FROM task WHERE due = @today SORT BY title';
const OVERDUE = 'FROM task WHERE due < @today SORT BY title';
const THIS_WEEK = 'FROM task WHERE due >= @today AND due <= @+6d SORT BY title';
const BY_DUE = 'FROM task SORT BY due, title';

describe('date queries over date-only dues, as before #928', () => {
  const database = databaseOf(DATE_ONLY);

  it('answers due today, overdue and due this week by the day', () => {
    expect(titles(database, DUE_TODAY)).toEqual(['Today plain', 'Today plain too']);
    expect(titles(database, OVERDUE)).toEqual(['Yesterday plain']);
    expect(titles(database, THIS_WEEK)).toEqual(['In six days', 'Today plain', 'Today plain too']);
  });

  it('sorts by due, a task with none last', () => {
    expect(titles(database, BY_DUE)).toEqual([
      'Yesterday plain',
      'Today plain',
      'Today plain too',
      'In six days',
      'In a week',
      'No due',
    ]);
  });
});

describe('date queries over timed dues (#928)', () => {
  const database = databaseOf({ ...DATE_ONLY, ...TIMED });

  it('finds a timed due by its day, whatever its time', () => {
    expect(titles(database, DUE_TODAY)).toEqual([
      'Today at five',
      'Today at nine',
      'Today at noon',
      'Today plain',
      'Today plain too',
    ]);
    expect(titles(database, OVERDUE)).toEqual(['Yesterday late', 'Yesterday plain']);
    expect(titles(database, THIS_WEEK)).toEqual([
      'In six days',
      'In six days at eight',
      'Today at five',
      'Today at nine',
      'Today at noon',
      'Today plain',
      'Today plain too',
    ]);
  });

  it('sorts within a day by time, the date-only dues first: the order of the due rule', () => {
    const sorted = titles(database, BY_DUE);
    expect(sorted).toEqual([
      'Yesterday plain',
      'Yesterday late',
      'Today plain',
      'Today plain too',
      'Today at nine',
      'Today at noon',
      'Today at five',
      'In six days',
      'In six days at eight',
      'In a week',
      'No due',
    ]);
    const all: Readonly<Record<string, string>> = { ...DATE_ONLY, ...TIMED };
    const byRule = Object.keys(all).sort(
      (left, right) =>
        compareDues(dueOf(all[left]), dueOf(all[right])) || left.localeCompare(right),
    );
    expect(sorted.slice(0, -1)).toEqual(byRule);
  });

  it('hands a task row its due as the day: what a row’s controls are judged against', () => {
    const columns = taskRowColumnsSql('f.path').join(', ');
    const rows = database
      .prepare(`SELECT f.title AS "title", ${columns} FROM files AS f ORDER BY f.title`)
      .all();
    const dueOfRow = (title: string) =>
      rows.find((row) => row['title'] === title)?.[TASK_ROW_COLUMNS.due];
    expect(dueOfRow('Today at five')).toBe('2999-03-13');
    expect(dueOfRow('Today at nine')).toBe('2999-03-13');
    expect(dueOfRow('Today plain')).toBe('2999-03-13');
    expect(dueOfRow('No due')).toBeNull();
  });
});
