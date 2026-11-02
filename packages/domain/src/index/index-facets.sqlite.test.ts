import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { compileNoteFacetsQuery, type FacetRow } from './index-facets.ts';

/** The index's tables a facet reads, as `apps/desktop/src-tauri/src/index.rs` creates them. */
function index() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE links (src TEXT NOT NULL, dst TEXT, target TEXT NOT NULL, kind TEXT NOT NULL);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);`);
  return {
    database,
    file: database.prepare('INSERT INTO files (path, title, modified, size) VALUES (?, ?, 1, 1)'),
    prop: database.prepare('INSERT INTO props (path, key, idx, value_text) VALUES (?, ?, ?, ?)'),
    link: database.prepare('INSERT INTO links VALUES (?, ?, ?, ?)'),
    tag: database.prepare('INSERT INTO tags VALUES (?, ?, ?, ?)'),
  };
}

const facetsOf = (database: DatabaseSync, paths: string[]) => {
  const { sql, parameters } = compileNoteFacetsQuery(paths);
  return database.prepare(sql).all(...parameters) as unknown as FacetRow[];
};

describe('the facet query, run against the index’s tables', () => {
  it('reads what the graph and the tag counts read of the notes asked about, and no others', () => {
    const { database, file, prop, link, tag } = index();
    file.run('a.md', 'Ay');
    file.run('b.md', 'Bee');
    prop.run('a.md', 'type', 0, 'task');
    prop.run('a.md', 'project', 0, '[[Bee]]');
    prop.run('a.md', 'status', 0, 'done');
    link.run('a.md', 'b.md', 'Bee', 'wikilink');
    link.run('a.md', null, 'Nowhere', 'wikilink');
    link.run('a.md', 'b.md', 'b.md', 'markdown');
    tag.run('a.md', 0, 'x', 'X');
    tag.run('b.md', 0, 'y', 'y');

    const rows = facetsOf(database, ['a.md']);

    expect(rows.map(({ facet, part, what, at, value }) => [facet, part, what, at, value])).toEqual(
      expect.arrayContaining([
        ['graph', 'title', 'Ay', null, null],
        ['graph', 'prop', 'type', 0, 'task'],
        ['graph', 'prop', 'project', 0, '[[Bee]]'],
        ['graph', 'link', 'b.md', null, null],
        ['tags', 'tag', 'x', 0, 'X'],
      ]),
    );
    // Not a status (the graph reads no plain property), an unresolved or markdown link, nor b.md's rows.
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.path === 'a.md')).toBe(true);
  });

  it('answers nothing for a note the index does not hold', () => {
    const { database } = index();
    expect(facetsOf(database, ['gone.md'])).toEqual([]);
  });

  it('binds every path, so many notes are asked at once', () => {
    const { database, file } = index();
    file.run('a.md', 'Ay');
    file.run("o'brien.md", 'Quote');
    expect(facetsOf(database, ['a.md', "o'brien.md"]).map((row) => row.path)).toEqual([
      'a.md',
      "o'brien.md",
    ]);
  });
});
