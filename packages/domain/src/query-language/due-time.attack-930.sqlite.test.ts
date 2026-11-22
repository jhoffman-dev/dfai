import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { compareDues, dueOf } from '../gtd/task-due.ts';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { parseObjectType } from '../types/property-def.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';

/**
 * attack-930: a table sorted by Due and the Today page's due rule
 * (`compareDues`, then title) are said to agree (ADR-0029 addendum, #928).
 * They part for dues the rule reads as the same minute or as no time at all.
 */
const TODAY = '2999-03-13';
const INDEX_TODAY = "date('now', 'localtime'";
const TYPES = [parseObjectType({ name: 'task', properties: { due: 'date', status: 'text' } })];

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

const BY_DUE = 'FROM task SORT BY due, title';

const byRule = (dues: Readonly<Record<string, string>>) =>
  Object.keys(dues).sort(
    (left, right) =>
      compareDues(dueOf(dues[left]), dueOf(dues[right])) || left.localeCompare(right),
  );

describe('a table sorted by due and the due rule (attack-930)', () => {
  it('agree for two dues in the same minute, one written with seconds', () => {
    const dues = { 'Alder call': '2999-03-13T09:00:59', 'Birch call': '2999-03-13T09:00' };
    expect(titles(databaseOf(dues), BY_DUE).slice(0, -1)).toEqual(byRule(dues));
  });

  it('agree for a due written at 24:00 beside one at 23:59 on the same day', () => {
    const dues = { 'Alder close': '2999-03-13T24:00', 'Birch close': '2999-03-13T23:59' };
    expect(titles(databaseOf(dues), BY_DUE).slice(0, -1)).toEqual(byRule(dues));
  });
});
