/**
 * Adversarial pass on Phase 23 (A23): the Archive's statements and the ones
 * that must leave archived notes out, run for real against SQLite over the
 * index's own tables. What is asserted is the rows.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { compileArchiveQuery } from './archive-query.ts';
import { compileTagCountsQuery } from '../tags/tag-query.ts';

function index() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
      value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL,
                       name TEXT NOT NULL);`);
  const file = database.prepare('INSERT INTO files (path, title) VALUES (?, ?)');
  const tag = database.prepare('INSERT INTO tags VALUES (?, ?, ?, ?)');
  const run = ({ sql, parameters }: { sql: string; parameters: readonly unknown[] }) =>
    database.prepare(sql).all(...(parameters as (string | number)[]));
  return { file, tag, run };
}

describe('the Archive finds a note by any word of its title, in any case (A23)', () => {
  it('finds “Überblick” when “über” is typed', () => {
    const { file, run } = index();
    file.run('Archive/Notes/Überblick.md', 'Überblick');
    const rows = run(compileArchiveQuery({ search: 'über' }));
    expect(rows.map((row) => row['path'])).toEqual(['Archive/Notes/Überblick.md']);
  });

  it('finds “Überblick” when “Überblick” is typed exactly as it is spelled', () => {
    const { file, run } = index();
    file.run('Archive/Notes/Überblick.md', 'Überblick');
    const rows = run(compileArchiveQuery({ search: 'Überblick' }));
    expect(rows.map((row) => row['path'])).toEqual(['Archive/Notes/Überblick.md']);
  });

  it('finds a title the disk spelled decomposed (NFD) when it is typed composed (NFC)', () => {
    const { file, run } = index();
    const decomposed = 'Café notes';
    file.run(`Archive/${decomposed}.md`, decomposed);
    const rows = run(compileArchiveQuery({ search: 'café' }));
    expect(rows).toHaveLength(1);
  });
});

describe('tags leave archived notes out, as the views and search do (A23)', () => {
  it('does not count a tag used only in an archived note', () => {
    const { file, tag, run } = index();
    file.run('Live.md', 'Live');
    file.run('Archive/Old.md', 'Old');
    tag.run('Live.md', 0, 'idea', 'idea');
    tag.run('Archive/Old.md', 0, 'finished', 'finished');
    const keys = run(compileTagCountsQuery(0)).map((row) => row['key']);
    expect(keys).toEqual(['idea']);
  });

  it('counts only the uses in notes still in use', () => {
    const { file, tag, run } = index();
    file.run('Live.md', 'Live');
    file.run('archive/Old.md', 'Old');
    tag.run('Live.md', 0, 'idea', 'idea');
    tag.run('archive/Old.md', 0, 'idea', 'Idea');
    expect(run(compileTagCountsQuery(0))).toEqual([{ key: 'idea', name: 'idea', count: 1 }]);
  });
});
