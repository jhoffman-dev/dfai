import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  compileLinkHintsQuery,
  LINK_HINTS_QUERY_COLUMNS,
  LINK_HINTS_PAGE_SIZE,
  type LinkHintsPart,
} from './link-hints-query.ts';

/** The index's tables, as `apps/desktop/src-tauri/src/index.rs` creates them. */
function index() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);`);
  const file = database.prepare(
    'INSERT INTO files (path, title, modified, size) VALUES (?, ?, ?, 1)',
  );
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text) VALUES (?, ?, ?, ?)',
  );
  const relation = database.prepare(
    'INSERT INTO relations (src, key, idx, target, dst) VALUES (?, ?, 0, ?, ?)',
  );
  return { database, file, prop, relation };
}

const run = (database: DatabaseSync, part: LinkHintsPart, page = 0) => {
  const { sql, parameters } = compileLinkHintsQuery(part, page);
  const statement = database.prepare(sql);
  expect(statement.columns().map((column) => column.name)).toEqual([...LINK_HINTS_QUERY_COLUMNS]);
  return statement.all(...parameters);
};

describe('the link hints queries, run against the index’s tables', () => {
  it('lists the vault’s own notes, never one in .atlas, a hidden folder or the Archive', () => {
    const { database, file } = index();
    file.run('People/Mara Quill.md', 'Mara Quill', 1);
    file.run('.atlas/templates/Person.md', 'Person', 1);
    file.run('.trash/Ghost.md', 'Ghost', 1);
    file.run('Archive/People/Old.md', 'Old', 1);
    expect(run(database, 'notes')).toEqual([
      { kind: 'note', path: 'People/Mara Quill.md', text: 'Mara Quill', uses: null, last: null },
    ]);
  });

  it('pages the notes by path, neither skipping nor repeating one', () => {
    const { database, file } = index();
    const count = LINK_HINTS_PAGE_SIZE + 3;
    for (let at = count - 1; at >= 0; at -= 1) {
      file.run(`Notes/${String(at).padStart(5, '0')}.md`, `Note ${at}`, 1);
    }
    const first = run(database, 'notes', 0);
    const second = run(database, 'notes', 1);
    expect(first).toHaveLength(LINK_HINTS_PAGE_SIZE);
    expect(second.map((row) => row['path'])).toEqual([
      'Notes/05000.md',
      'Notes/05001.md',
      'Notes/05002.md',
    ]);
  });

  it('lists each alias, under either key, but not an empty one', () => {
    const { database, prop } = index();
    prop.run('People/Mara Quill.md', 'aliases', 0, 'MQ');
    prop.run('People/Mara Quill.md', 'aliases', 1, 'Mara');
    prop.run('People/Tobias Fenn.md', 'alias', 0, 'Toby');
    prop.run('People/Tobias Fenn.md', 'aliases', 0, '');
    prop.run('People/Tobias Fenn.md', 'role', 0, 'Lead');
    expect(run(database, 'aliases').map((row) => [row['path'], row['text']])).toEqual([
      ['People/Mara Quill.md', 'MQ'],
      ['People/Mara Quill.md', 'Mara'],
      ['People/Tobias Fenn.md', 'Toby'],
    ]);
  });

  it('counts the links pointing at each note, and when the latest linking note changed', () => {
    const { database, file, relation } = index();
    file.run('Tasks/a.md', 'A', 100);
    file.run('Tasks/b.md', 'B', 300);
    relation.run('Tasks/a.md', 'project', '[[Garden]]', 'Projects/Garden.md');
    relation.run('Tasks/b.md', 'project', '[[Garden]]', 'Projects/Garden.md');
    relation.run('Tasks/a.md', 'project', '[[Nowhere]]', null);
    expect(run(database, 'uses')).toEqual([
      { kind: 'use', path: 'Projects/Garden.md', text: null, uses: 2, last: 300 },
    ]);
  });

  it('counts no link from a template, a hidden folder or an archived note', () => {
    const { database, file, relation } = index();
    file.run('.atlas/templates/Task.md', 'Task', 900);
    file.run('Archive/Tasks/old.md', 'Old', 800);
    file.run('.trash/gone.md', 'Gone', 700);
    file.run('Tasks/a.md', 'A', 100);
    for (const src of [
      '.atlas/templates/Task.md',
      'Archive/Tasks/old.md',
      '.trash/gone.md',
      'Tasks/a.md',
    ]) {
      relation.run(src, 'project', '[[Garden]]', 'Projects/Garden.md');
    }
    expect(run(database, 'uses').map((row) => [row['path'], row['uses'], row['last']])).toEqual([
      ['Projects/Garden.md', 1, 100],
    ]);
  });
});
