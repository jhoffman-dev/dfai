import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { foldedPersonName } from '../people/person-match.ts';
import { compileTitledNotesQuery } from './assist-queries.ts';

/**
 * Second attack on #906 (PR #907). A new person is never added under a name
 * an existing note already has, folded as `foldedPersonName` folds it (case,
 * accents, spacing). The query that finds those notes folds with SQLite's
 * `lower()`, which folds ASCII letters only, so names the fold calls equal
 * are not found and the add is planned.
 */

function titlesTaken(stored: string, asked: string): Set<string> {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL)');
  database
    .prepare('INSERT INTO files (path, title) VALUES (?, ?)')
    .run(`Notes/${stored}.md`, stored);
  const { sql, parameters } = compileTitledNotesQuery([asked]);
  const rows = database.prepare(sql).all(...(parameters as string[])) as { title: string }[];
  database.close();
  return new Set(rows.map((row) => foldedPersonName(row.title)));
}

describe('attack2-907: a taken title is found however it is spelt', () => {
  it.each([
    ['accents', 'Renée Fenn', 'Renee Fenn'],
    ['Unicode form (one file name on APFS)', 'Renée Fenn', 'Renée Fenn'],
    ['non-ASCII case', 'ÉLODIE FENN', 'élodie fenn'],
  ])('finds a note whose title differs only by %s', (_, stored, asked) => {
    expect(foldedPersonName(stored)).toBe(foldedPersonName(asked));
    expect(titlesTaken(stored, asked).has(foldedPersonName(asked))).toBe(true);
  });
});
