import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { compileAtlasQuery } from '../query-language/compile.ts';
import { parseAtlasQuery } from '../query-language/parse.ts';
import { printAtlasQuery } from '../query-language/print.ts';
import { QUERY_TEST_TYPES } from '../query-language/query-fixtures.ts';
import { MAX_QUERY_LIMIT } from '../query/view-query.ts';
import { automationQuery, MAX_ACTIONS_PER_RUN, movingDate } from './automation-query.ts';

const ARCHIVE = { kind: 'archive' } as const;

/**
 * An automation's query, pinned to the day it is handed and run for real
 * against SQLite over the index's tables. The days are far from the real one,
 * so a query that fell back to the index's own clock would find other notes.
 */
const TODAY = '2999-03-10';
const dayMs = (day: string) => Date.parse(`${day}T12:00:00Z`);

const NOTES = [
  { path: 'tasks/Old done.md', status: 'done', due: '2999-03-01', modified: '2999-01-01' },
  { path: 'tasks/Fresh done.md', status: 'done', due: '2999-03-20', modified: '2999-03-09' },
  { path: 'tasks/Old doing.md', status: 'doing', due: '2999-03-09', modified: '2999-01-01' },
  { path: 'Archive/tasks/Gone.md', status: 'done', due: '2999-01-01', modified: '2999-01-01' },
];

function buildIndex(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);`);
  for (const note of NOTES) {
    const title = note.path.replace(/^.*\//, '').replace(/\.md$/, '');
    database
      .prepare('INSERT INTO files VALUES (?, ?, ?, ?, 1)')
      .run(note.path, title, '', dayMs(note.modified));
    const frontmatter = { type: 'task', status: note.status, due: note.due };
    for (const row of indexablePropertiesOf(frontmatter)) {
      database
        .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(note.path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
  }
  return database;
}

const database = buildIndex();

function titles(
  text: string,
  olderThanDays: number | null = null,
  among?: readonly string[],
): unknown[] {
  const query = automationQuery({
    query: parseAtlasQuery(text),
    today: TODAY,
    olderThanDays,
    action: ARCHIVE,
    ...(among !== undefined && { among }),
  });
  // Printed and read again, as the runner asks it: the pinned days must survive the text.
  const reread = parseAtlasQuery(printAtlasQuery(query));
  const compiled = compileAtlasQuery(reread, { types: QUERY_TEST_TYPES, resolveLink: () => null });
  const rows = database.prepare(compiled.sql).all(...compiled.parameters);
  return rows.map((row) => (row as Record<string, unknown>)['title']).sort();
}

describe('automationQuery, run against SQLite', () => {
  it('answers @today with the day it is handed, not the index’s clock', () => {
    expect(titles('FROM task WHERE due < @today')).toEqual(['Old doing', 'Old done']);
    expect(titles('FROM task WHERE due = @yesterday')).toEqual(['Old doing']);
  });

  it('adds the age filter on modified: only notes untouched for that many days', () => {
    expect(titles('FROM task WHERE status = done', 30)).toEqual(['Old done']);
    expect(titles('FROM task WHERE status = done')).toEqual(['Fresh done', 'Old done']);
  });

  it('asks only among the notes a note trigger heard of, and still by its own where', () => {
    const among = ['tasks/Old done.md', 'tasks/Old doing.md'];
    expect(titles('FROM task', null, among)).toEqual(['Old doing', 'Old done']);
    expect(titles('FROM task WHERE status = done OR status = doing', null, among)).toEqual([
      'Old doing',
      'Old done',
    ]);
    expect(titles('FROM task WHERE status = done', null, among)).toEqual(['Old done']);
    expect(titles('FROM task', null, ['tasks/Fresh done.md'])).toEqual(['Fresh done']);
    expect(titles('FROM task', null, [])).toEqual([]);
  });

  it('keeps an archived note out, as every query does', () => {
    expect(titles('FROM task', 30)).not.toContain('Gone');
    expect(titles('FROM task', 30)).toEqual(['Old doing', 'Old done']);
  });
});

describe('automationQuery, as a query', () => {
  const pinned = (text: string, olderThanDays: number | null = null) =>
    printAtlasQuery(
      automationQuery({
        query: parseAtlasQuery(text),
        today: TODAY,
        olderThanDays,
        action: ARCHIVE,
      }),
    );

  it('pins every moving date, however deep in the conditions', () => {
    expect(
      pinned('FROM task WHERE NOT (due < @weekAgo OR due > @weekAhead) AND due != @tomorrow'),
    ).toContain('NOT (due < 2999-03-03 OR due > 2999-03-17) AND due != 2999-03-11');
  });

  it('pins a count from today and the start of the week to the day it is handed', () => {
    // 2999-03-10 is a Sunday; its week began on Monday the 4th.
    expect(pinned('FROM task WHERE due > @-30d AND due < @+2w AND due >= @startOfWeek')).toContain(
      'due > 2999-02-08 AND due < 2999-03-24 AND due >= 2999-03-04',
    );
  });

  it('asks for as many notes as a query may return, unless the query has its own limit', () => {
    const query = automationQuery({
      query: parseAtlasQuery('FROM task'),
      today: TODAY,
      olderThanDays: null,
      action: ARCHIVE,
    });
    // Far more than a run may do: notes it would leave as they are go before the cap is counted.
    expect(query.limit).toBe(MAX_QUERY_LIMIT);
    expect(MAX_QUERY_LIMIT).toBeGreaterThan(MAX_ACTIONS_PER_RUN);
    expect(pinned('FROM task LIMIT 5')).toContain('LIMIT 5');
  });

  it('adds the age as its own condition beside the query’s', () => {
    expect(pinned('FROM task WHERE status = done', 30)).toContain(
      'status = done AND modified < 2999-02-08',
    );
    expect(pinned('FROM task', 1)).toContain('WHERE modified < 2999-03-09');
  });

  it('leaves an unknown moving date for the check to refuse', () => {
    expect(pinned('FROM task WHERE due < @someday')).toContain('@someday');
  });
});

describe('movingDate', () => {
  it.each([
    ['today', '2999-03-10'],
    ['yesterday', '2999-03-09'],
    ['tomorrow', '2999-03-11'],
    ['weekAgo', '2999-03-03'],
    ['weekAhead', '2999-03-17'],
    ['monthAhead', '2999-04-10'],
    ['someday', null],
  ])('@%s is %s on 2999-03-10', (name, day) => expect(movingDate(name, TODAY)).toBe(day));

  it('rolls a month on from the 31st into the month after, as the index does', () => {
    expect(movingDate('monthAhead', '2026-01-31')).toBe('2026-03-03');
    expect(movingDate('monthAhead', '2026-12-15')).toBe('2027-01-15');
  });

  it('has no month ahead of a day that is no day', () => {
    expect(movingDate('monthAhead', 'soon')).toBeNull();
  });
});
