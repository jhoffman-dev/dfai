import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { relationsOf } from '../index/relation-rows.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';
import { parseObjectType } from '../types/property-def.ts';
import { QUERY_TEST_TYPES } from './query-fixtures.ts';

/**
 * #110 (attack on PR #611): what a query reads a note's values as, run
 * against SQLite. A note's `type` in any case, as the rest of DFAI reads it;
 * a date field's values are the days it holds; a field that holds one value
 * is tested on the one its cell shows.
 */
const NOTES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'Plain task': { type: 'task', due: '2026-10-01', notes: 'alpha' },
  'Capital task': { type: 'Task', due: '2026-10-01' },
  'Spaced task': { type: ' TASK ', due: '2026-10-01' },
  'Not a task': { type: 'tasks', due: '2026-10-01' },
  'Due in words': { type: 'task', due: 'TBD' },
  'Due no calendar has': { type: 'task', due: '2026-02-30' },
  'No due': { type: 'task' },
  'Two dues': { type: 'task', due: ['2026-11-30', '2026-10-01'] },
  'Words then a day': { type: 'task', due: ['soon', '2026-10-05'] },
  'Two notes': { type: 'task', notes: ['alpha', 'beta'] },
  'Two labels': { type: 'task', labels: ['red', 'blue'] },
  'Beta and a blank': { type: 'task', notes: ['beta', ''] },
  'Words for a number': { type: 'task', estimate: 'lots' },
  Shed: { type: 'project', due: ['2026-12-31', '2026-10-01'] },
  'Hop to the shed': { type: 'task', project: '[[Shed]]' },
};

const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                      modified INTEGER NOT NULL, size INTEGER NOT NULL);
  CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                      value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
  CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                          target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);`);
const resolve = (target: string) => (target === 'Shed' ? 'tasks/Shed.md' : null);
for (const [title, frontmatter] of Object.entries(NOTES)) {
  const path = `tasks/${title}.md`;
  database.prepare('INSERT INTO files VALUES (?, ?, ?, 0, 1)').run(path, title, '');
  for (const row of indexablePropertiesOf(frontmatter)) {
    database
      .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
  }
  for (const row of relationsOf(frontmatter, resolve)) {
    database
      .prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)')
      .run(path, row.key, row.index, row.target, row.name, row.path);
  }
}

function rows(text: string): Record<string, unknown>[] {
  const compiled = compileAtlasQuery(parseAtlasQuery(text), {
    types: QUERY_TEST_TYPES,
    resolveLink: resolve,
  });
  return database.prepare(compiled.sql).all(...compiled.parameters);
}

const titles = (text: string) =>
  rows(text)
    .map((row) => String(row['title']))
    .sort();

describe("FROM reads a note's type as DFAI does: in any case and spacing", () => {
  it('lists a note that says type: Task or TASK under FROM task, and not one that says tasks', () => {
    const found = titles('FROM task WHERE due = 2026-10-01');
    expect(found).toEqual(['Capital task', 'Plain task', 'Spaced task']);
    expect(found).not.toContain('Not a task');
  });

  it('lists a note that says type: task under a type the vault spells Task', () => {
    const spelt = parseObjectType({ name: 'Task', properties: { due: 'date' } });
    const compiled = compileAtlasQuery(parseAtlasQuery('FROM Task WHERE due = 2026-10-01'), {
      types: [spelt],
      resolveLink: () => null,
    });
    const found = database.prepare(compiled.sql).all(...compiled.parameters);
    expect(found.map((row) => row['title'])).toContain('Plain task');
  });

  // GROUP BY type groups by it, so every spelling is named as the vault names the type.
  it('names the type as the vault does when a query reads from several', () => {
    const capital = rows('FROM task, project WHERE due = 2026-10-01').find(
      (row) => row['title'] === 'Capital task',
    );
    expect(capital?.['type']).toBe('task');
  });
});

describe('a date field holds the days it can read', () => {
  it('is empty when what it holds is words, or a day no calendar has', () => {
    const empty = titles('FROM task WHERE due IS EMPTY');
    expect(empty).toEqual(
      expect.arrayContaining(['Due in words', 'Due no calendar has', 'No due']),
    );
    expect(empty).not.toContain('Plain task');
    expect(titles('FROM task WHERE due IS NOT EMPTY')).not.toContain('Due in words');
  });

  it('compares words as no date: not before a day, and not that day', () => {
    expect(titles('FROM task WHERE due < 2026-12-31')).not.toContain('Due in words');
    expect(titles('FROM task WHERE due != 2026-10-01')).toContain('Due in words');
  });

  it('reads its first day, past any words before it', () => {
    expect(titles('FROM task WHERE due = 2026-10-05')).toContain('Words then a day');
  });
});

describe('a field that holds one value holds it as Today reads it', () => {
  it('reads a single date written as two days as the first of them', () => {
    expect(titles('FROM task WHERE due = 2026-11-30')).toContain('Two dues');
    expect(titles('FROM task WHERE due < 2026-11-01')).not.toContain('Two dues');
    expect(titles('FROM task WHERE due != 2026-10-01')).toContain('Two dues');
  });

  // As Today reads a status written as a list (singleText, gtdStatusOf): no value.
  it('reads single text written as a list as no value', () => {
    expect(titles('FROM task WHERE notes = alpha')).not.toContain('Two notes');
    expect(titles('FROM task WHERE notes = beta')).not.toContain('Two notes');
    expect(titles('FROM task WHERE notes IS EMPTY')).toContain('Two notes');
    expect(titles('FROM task WHERE notes != alpha')).toContain('Two notes');
  });

  it('still asks a field that holds many whether any value matches', () => {
    expect(titles('FROM task WHERE labels = blue')).toEqual(['Two labels']);
    expect(titles('FROM task WHERE labels = red')).toEqual(['Two labels']);
  });
});

describe('a number field holds the numbers it can read', () => {
  it('is empty when what it holds is words, as its cell is', () => {
    const [row] = rows("FROM task WHERE title = 'Words for a number' SHOW estimate");
    expect(row?.['estimate']).toBeNull();
    expect(titles('FROM task WHERE estimate IS EMPTY')).toContain('Words for a number');
  });
});

describe('a field reached through a relation holds its value as the linked note does', () => {
  // The project's single due written as two days is its first, in the cell and in the filter.
  it("compares project.due on the linked project's first day, as its cell shows", () => {
    const [row] = rows("FROM task WHERE title = 'Hop to the shed' SHOW project.due");
    expect(row?.['project.due']).toBe('2026-12-31');
    expect(titles('FROM task WHERE project.due < 2026-11-01')).not.toContain('Hop to the shed');
    expect(titles('FROM task WHERE project.due = 2026-12-31')).toContain('Hop to the shed');
  });
});

describe('a blank item is no item', () => {
  // Decided with PR #616's review: `status: [next-action, ""]` holds
  // next-action, in a query as in Today (gtdStatusOf drops blank items).
  it('reads a single field written as one value beside blanks as that value', () => {
    expect(titles('FROM task WHERE notes = beta')).toContain('Beta and a blank');
    expect(titles('FROM task WHERE notes IS EMPTY')).not.toContain('Beta and a blank');
    const [row] = rows("FROM task WHERE title = 'Beta and a blank' SHOW notes");
    expect(row?.['notes']).toBe('beta');
  });
});
