import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { compileGraphQuery, GRAPH_PAGE_SIZE, type GraphQueryPart } from './graph-query.ts';

/** The index's tables, as `apps/desktop/src-tauri/src/index.rs` creates them. */
function index() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE links (src TEXT NOT NULL, dst TEXT, target TEXT NOT NULL, kind TEXT NOT NULL);`);
  const file = database.prepare(
    'INSERT INTO files (path, title, modified, size) VALUES (?, ?, 1, 1)',
  );
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text) VALUES (?, ?, ?, ?)',
  );
  const link = database.prepare('INSERT INTO links VALUES (?, ?, ?, ?)');
  return { database, file, prop, link };
}

const run = (database: DatabaseSync, part: GraphQueryPart, page = 0) => {
  const { sql, parameters } = compileGraphQuery(part, page);
  return database.prepare(sql).all(...parameters);
};

describe('the graph queries, run against the index’s tables', () => {
  it('lists every note with its first type, or none', () => {
    const { database, file, prop } = index();
    file.run('b.md', 'Bee');
    file.run('a.md', 'Ay');
    prop.run('a.md', 'type', 1, 'second');
    prop.run('a.md', 'type', 0, 'task');
    prop.run('a.md', 'status', 0, 'done');
    expect(run(database, 'notes')).toEqual([
      { path: 'a.md', title: 'Ay', type: 'task' },
      { path: 'b.md', title: 'Bee', type: null },
    ]);
  });

  it('names only the vault’s own notes for a relation: none in .atlas or a hidden folder', () => {
    const { database, file } = index();
    file.run('people/Julie.md', 'Julie');
    file.run('.atlas/templates/Person.md', 'Template');
    file.run('.trash/Ghost.md', 'Ghost');
    file.run('lib/Node_Modules/x.md', 'Pruned');
    expect(run(database, 'namedNotes')).toEqual([{ path: 'people/Julie.md', title: 'Julie' }]);
  });

  it('lists resolved wiki links only', () => {
    const { database, link } = index();
    link.run('a.md', 'b.md', 'b', 'wikilink');
    link.run('a.md', null, 'Ghost', 'wikilink');
    link.run('a.md', 'c.md', 'c.md', 'markdown');
    expect(run(database, 'links')).toEqual([{ source: 'a.md', target: 'b.md' }]);
  });

  it('lists every property written as a wiki link, but not a note’s type', () => {
    const { database, prop } = index();
    prop.run('a.md', 'project', 0, '[[DFAI]]');
    prop.run('a.md', 'related', 1, '[[Two]]');
    prop.run('a.md', 'status', 0, 'done');
    prop.run('a.md', 'type', 0, '[[task]]');
    prop.run('a.md', 'note', 0, 'see [[DFAI]]');
    expect(run(database, 'relations')).toEqual([
      { source: 'a.md', key: 'project', value: '[[DFAI]]' },
      { source: 'a.md', key: 'related', value: '[[Two]]' },
    ]);
  });

  it('pages by the host’s row cap', () => {
    const { database, file } = index();
    for (let at = 0; at < GRAPH_PAGE_SIZE + 2; at += 1)
      file.run(`n${String(at).padStart(5, '0')}.md`, 'n');
    expect(run(database, 'notes', 0)).toHaveLength(GRAPH_PAGE_SIZE);
    expect(run(database, 'notes', 1)).toHaveLength(2);
  });
});
