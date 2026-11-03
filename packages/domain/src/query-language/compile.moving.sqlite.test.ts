import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';
import { QUERY_TEST_TYPES } from './query-fixtures.ts';
import { QueryTextError } from './query-text-error.ts';

/**
 * Counts from today and the start of the week, run for real against SQLite,
 * on a fixed day: the statement counts from TODAY instead of from the index's
 * clock, so the edges of every range are known and midnight moves none of them.
 */
const TODAY = '2999-03-13';
const INDEX_TODAY = "date('now', 'localtime'";

const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                      modified INTEGER, size INTEGER NOT NULL);
  CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                      value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);`);

/** TODAY, moved by these modifiers, as SQLite moves it. */
function indexDay(...modifiers: string[]): string {
  const marks = modifiers.map(() => ', ?').join('');
  const row = database.prepare(`SELECT date(?${marks}) AS day`).get(TODAY, ...modifiers);
  return String(row?.['day']);
}

const MONDAY = ['-6 days', 'weekday 1'];

const DUE: readonly [string, string][] = [
  ['Ages ago', indexDay('-400 days')],
  ['Thirty-one days ago', indexDay('-31 days')],
  ['Thirty days ago', indexDay('-30 days')],
  ['Twenty-nine days ago', indexDay('-29 days')],
  ['Sunday before', indexDay(...MONDAY, '-1 day')],
  ['This Monday', indexDay(...MONDAY)],
  ['In a fortnight', indexDay('+14 days')],
  ['In fifteen days', indexDay('+15 days')],
];

for (const [title, due] of DUE) {
  const path = `tasks/${title}.md`;
  database.prepare('INSERT INTO files VALUES (?, ?, ?, ?, 1)').run(path, title, '', 0);
  for (const row of indexablePropertiesOf({ type: 'task', due })) {
    database
      .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
  }
}

function titles(text: string): unknown[] {
  const compiled = compileAtlasQuery(parseAtlasQuery(text), {
    types: QUERY_TEST_TYPES,
    resolveLink: () => null,
  });
  return database
    .prepare(compiled.sql.replaceAll(INDEX_TODAY, `date('${TODAY}'`))
    .all(...compiled.parameters)
    .map((row) => row['title']);
}

describe('compileAtlasQuery, run against SQLite: dates counted from today', () => {
  it('counts days back: > @-30d leaves out the 30th day back, >= takes it', () => {
    const after = titles('FROM task WHERE due > @-30d');
    expect(after).toContain('Twenty-nine days ago');
    expect(after).not.toContain('Thirty days ago');
    expect(after).not.toContain('Thirty-one days ago');
    expect(titles('FROM task WHERE due >= @-30d')).toContain('Thirty days ago');
    expect(titles('FROM task WHERE due = @-30d')).toEqual(['Thirty days ago']);
  });

  it('counts weeks forward as seven days each', () => {
    const within = titles('FROM task WHERE due <= @+2w');
    expect(within).toContain('In a fortnight');
    expect(within).not.toContain('In fifteen days');
    expect(titles('FROM task WHERE due = @+2w')).toEqual(['In a fortnight']);
  });

  it('counts years back', () => {
    expect(titles('FROM task WHERE due < @-1y')).toEqual(['Ages ago']);
  });

  it('refuses a count past the last day SQLite can date, rather than matching nothing', () => {
    // Four digits are allowed, but @+9999y lands in the year 12025, which date() answers with NULL,
    // so every task is "due before" it and the query still lists none of them.
    for (const text of ['FROM task WHERE due < @+9999y', 'FROM task WHERE due < @+7974y']) {
      let answered: unknown[];
      try {
        answered = titles(text);
      } catch (error) {
        expect(error).toBeInstanceOf(QueryTextError);
        continue;
      }
      expect({ text, answered: answered.length }).toEqual({ text, answered: DUE.length });
    }
  });

  it('starts the week on Monday', () => {
    const thisWeek = titles('FROM task WHERE due >= @startOfWeek');
    expect(thisWeek).toContain('This Monday');
    expect(thisWeek).not.toContain('Sunday before');
    expect(titles('FROM task WHERE due = @startOfWeek')).toEqual(['This Monday']);
  });
});
