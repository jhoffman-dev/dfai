import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { relationsOf } from '../index/relation-rows.ts';
import { compileAtlasQuery } from '../query-language/compile.ts';
import { parseAtlasQuery } from '../query-language/parse.ts';
import { parseObjectType } from '../types/property-def.ts';
import { GTD_VIEW_FILES, NEXT_ACTIONS_QUERY } from './gtd-views.ts';
import { TASK_TYPE_FILE } from './task-type.ts';

/**
 * P30-02: the GTD views' queries run for real against SQLite, over the
 * index's own tables, on a fixed day. `@today` is answered by the index's
 * clock when a view runs; here it is pinned to the day the test is about,
 * exactly as an automation pins it.
 */
const TYPES = [
  TASK_TYPE_FILE.type,
  parseObjectType({ name: 'person', properties: {} }),
  parseObjectType({ name: 'project', properties: {} }),
  parseObjectType({ name: 'area', properties: {} }),
];

const TASKS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'Call the bank': { status: 'next-action' },
  'File the claim': { status: 'next-action', defer: '2026-10-07' },
  'Book the hall': { status: 'next-action', defer: '2026-10-08' },
  'Plant bulbs': { status: 'next-action', defer: '2026-10-09' },
  'Draft the memo': { status: 'in-progress' },
  'Hear from Mara': { status: 'waiting', waiting_on: '[[Mara Quill]]' },
  'Learn the cello': { status: 'someday' },
  Retire: { status: 'longterm' },
  'Sort the post': { status: 'inbox' },
};

function index(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);`);
  for (const [title, values] of Object.entries(TASKS)) {
    const path = `tasks/${title}.md`;
    const frontmatter = { type: 'task', ...values };
    database.prepare('INSERT INTO files VALUES (?, ?, ?, 1, 1)').run(path, title, '');
    for (const row of indexablePropertiesOf(frontmatter)) {
      database
        .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
    for (const row of relationsOf(frontmatter, () => null)) {
      database
        .prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)')
        .run(path, row.key, row.index, row.target, row.name, row.path);
    }
  }
  return database;
}

const database = index();

/** The titles a view's query lists on `today`. */
function listed(query: string, today: string): string[] {
  const pinned = query.replaceAll('@today', today);
  const compiled = compileAtlasQuery(parseAtlasQuery(pinned), {
    types: TYPES,
    resolveLink: () => null,
  });
  const rows = database.prepare(compiled.sql).all(...compiled.parameters) as { title: string }[];
  return rows.map((row) => row.title).sort();
}

const viewQuery = (name: string) => GTD_VIEW_FILES.find((view) => view.name === name)!.query;

describe('Next actions', () => {
  it('reads the day it is shown on, rather than a day fixed when it was written', () => {
    expect(NEXT_ACTIONS_QUERY).toContain('@today');
  });

  it('leaves out a task deferred to a later day, until that day comes', () => {
    expect(listed(NEXT_ACTIONS_QUERY, '2026-10-08')).toEqual([
      'Book the hall',
      'Call the bank',
      'File the claim',
    ]);
    expect(listed(NEXT_ACTIONS_QUERY, '2026-10-09')).toEqual([
      'Book the hall',
      'Call the bank',
      'File the claim',
      'Plant bulbs',
    ]);
  });
});

describe('the other GTD views', () => {
  it('Inbox lists what is waiting to be processed', () => {
    expect(listed(viewQuery('Inbox'), '2026-10-08')).toEqual(['Sort the post']);
  });

  it('Waiting lists what waits on someone', () => {
    expect(listed(viewQuery('Waiting'), '2026-10-08')).toEqual(['Hear from Mara']);
  });

  it('Someday and Longterm lists both, and nothing else', () => {
    expect(listed(viewQuery('Someday and Longterm'), '2026-10-08')).toEqual([
      'Learn the cello',
      'Retire',
    ]);
  });
});
