import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { taskAsRead } from '../today/row-read.ts';
import { compileReviewTasksQuery, reviewTask } from './review-query.ts';

/**
 * Attack on PR #602 (#108): the Today page lists a task by the `focus` the
 * review statement reads from the index, and refuses a row's action when the
 * file's `focus`, read by `taskAsRead`, differs. The two must agree on every
 * value a person may write, or Keep and Drop are refused for good.
 */
interface Fixture {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly modified?: number;
  /** Each relation the note holds: key, the target as written, and the note it resolved to. */
  readonly relations?: readonly { key: string; name: string; dst: string | null }[];
}

function indexOf(notes: Readonly<Record<string, Fixture>>) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);`);
  for (const [path, note] of Object.entries(notes)) {
    const title = path.replace(/^.*\//, '').replace(/\.md$/, '');
    database
      .prepare('INSERT INTO files VALUES (?, ?, ?, ?, 0)')
      .run(path, title, '', note.modified ?? 1);
    for (const row of indexablePropertiesOf(note.frontmatter)) {
      database
        .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
    (note.relations ?? []).forEach((relation, at) =>
      database
        .prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)')
        .run(path, relation.key, at, relation.name, relation.name.toLowerCase(), relation.dst),
    );
  }
  return database;
}

function tasksOf(notes: Readonly<Record<string, Fixture>>) {
  const { sql, parameters } = compileReviewTasksQuery();
  const rows = indexOf(notes)
    .prepare(sql)
    .all(...parameters) as Parameters<typeof reviewTask>[0][];
  return rows.map(reviewTask);
}

const HOSTILE: readonly unknown[] = [
  '2026-02-30',
  '2026-10-28T09:00',
  '2026-10-28T23:30:00-07:00',
  ['2026-10-01', 'writing'],
  ['writing', '2026-10-01'],
  ['2026-10-28', '2026-10-01'],
  5,
  20261028,
  '',
  null,
  '[[Daily/2026-10-28]]',
  '0001-01-01',
  '9999-12-31',
  'writing',
];

describe('the review statement and taskAsRead read `focus` alike (#108)', () => {
  it.each(HOSTILE.map((value) => [JSON.stringify(value), value]))('focus %s', (_, focus) => {
    const frontmatter = { type: 'task', status: 'next-action', focus };
    const [read] = tasksOf({ 'Tasks/Paint.md': { frontmatter } });

    expect(read?.focus ?? null).toBe(taskAsRead(frontmatter).focus);
  });
});
