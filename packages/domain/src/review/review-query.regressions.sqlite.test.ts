import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { compileReviewDoneQuery, reviewSource } from './review-query.ts';

/** Regression tests from the review of PR #539 (#40): the week's wins, run for real against SQLite. */

interface Fixture {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Null for a note the index cannot date (ADR-0053); 1 when left out. */
  readonly modified?: number | null;
  /** Each relation the note holds: key, the target as written, and the note it resolved to. */
  readonly relations?: readonly { key: string; name: string; dst: string | null }[];
}

function indexOf(notes: Readonly<Record<string, Fixture>>) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);`);
  for (const [path, note] of Object.entries(notes)) {
    const title = path.replace(/^.*\//, '').replace(/\.md$/, '');
    database
      .prepare('INSERT INTO files VALUES (?, ?, ?, ?, 0)')
      .run(path, title, '', note.modified === undefined ? 1 : note.modified);
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

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-23T15:00:00Z');

describe('the Friday review’s wins', () => {
  it('leaves out a task finished long ago that was only edited this week', () => {
    const { sql, parameters } = compileReviewDoneQuery(NOW - 7 * DAY);
    const rows = indexOf({
      // Finished in September; filed into the Archive (a rewrite) on Wednesday.
      'Archive/Tasks/Old win.md': {
        frontmatter: { type: 'task', status: 'archive', completed: '2026-09-01' },
        modified: NOW - 2 * DAY,
      },
      'Tasks/New win.md': {
        frontmatter: { type: 'task', status: 'archive', completed: '2026-10-22' },
        modified: NOW - DAY,
      },
    })
      .prepare(sql)
      .all(...parameters) as Record<string, unknown>[];
    expect(rows.map(reviewSource).map(({ path }) => path)).toEqual(['Tasks/New win.md']);
  });

  it('counts a task with no completed day by when it was last changed, as before', () => {
    const { sql, parameters } = compileReviewDoneQuery(NOW - 7 * DAY);
    const rows = indexOf({
      'Tasks/No day.md': {
        frontmatter: { type: 'task', status: 'archive' },
        modified: NOW - DAY,
      },
      'Tasks/No day, long ago.md': {
        frontmatter: { type: 'task', status: 'archive' },
        modified: NOW - 20 * DAY,
      },
    })
      .prepare(sql)
      .all(...parameters) as Record<string, unknown>[];
    expect(rows.map(reviewSource).map(({ path }) => path)).toEqual(['Tasks/No day.md']);
  });

  it('counts an undated task only by its completed day: unknown is never "changed this week" (ADR-0053)', () => {
    const { sql, parameters } = compileReviewDoneQuery(NOW - 7 * DAY);
    const rows = indexOf({
      'Tasks/Undated, no day.md': {
        frontmatter: { type: 'task', status: 'archive' },
        modified: null,
      },
      'Tasks/Undated, done Thursday.md': {
        frontmatter: { type: 'task', status: 'archive', completed: '2026-10-22' },
        modified: null,
      },
    })
      .prepare(sql)
      .all(...parameters) as Record<string, unknown>[];
    expect(rows.map(reviewSource).map(({ path }) => path)).toEqual([
      'Tasks/Undated, done Thursday.md',
    ]);
  });

  it('stops at the end of the week it is asked for, so no win is counted in two reviews', () => {
    const week = {
      sinceDay: '2026-10-17',
      until: NOW,
      untilDay: '2026-10-23',
    };
    const { sql, parameters } = compileReviewDoneQuery(NOW - 7 * DAY, week);
    const rows = indexOf({
      'Tasks/This week.md': {
        frontmatter: { type: 'task', status: 'archive', completed: '2026-10-23' },
        modified: NOW - 1000,
      },
      'Tasks/Next week.md': {
        frontmatter: { type: 'task', status: 'archive', completed: '2026-10-24' },
        modified: NOW + DAY,
      },
      'Tasks/Last week.md': {
        frontmatter: { type: 'task', status: 'archive', completed: '2026-10-16' },
        modified: NOW - 6 * DAY,
      },
    })
      .prepare(sql)
      .all(...parameters) as Record<string, unknown>[];
    expect(rows.map(reviewSource).map(({ path }) => path)).toEqual(['Tasks/This week.md']);
  });
});
