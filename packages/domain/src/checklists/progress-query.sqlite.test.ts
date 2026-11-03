import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { relationsOf } from '../index/relation-rows.ts';
import { resolveWikiLinkTarget } from '../markdown/resolve-wikilink.ts';
import { compileAtlasQuery } from '../query-language/compile.ts';
import { parseAtlasQuery } from '../query-language/parse.ts';
import { parseObjectType } from '../types/property-def.ts';
import { createVaultPath } from '../vault/vault-path.ts';

/**
 * P30-03: `progress` in a DFAI query, run for real against SQLite over the
 * index's own tables, each file holding the progress refreshing the index
 * worked out from its checklist (`checklistProgress`) — null with no box.
 */
const TYPES = [
  parseObjectType({
    name: 'task',
    properties: { project: { kind: 'relation', target: 'project' } },
  }),
  parseObjectType({ name: 'project', properties: {} }),
];

const NOTES: readonly {
  path: string;
  progress: number | null;
  frontmatter: Record<string, unknown>;
}[] = [
  { path: 'Launch.md', progress: 50, frontmatter: { type: 'project' } },
  { path: 'Book the hall.md', progress: 40, frontmatter: { type: 'task', project: '[[Launch]]' } },
  { path: 'Order chairs.md', progress: 100, frontmatter: { type: 'task' } },
  { path: 'Ring Mara.md', progress: 0, frontmatter: { type: 'task' } },
  { path: 'Plain.md', progress: null, frontmatter: { type: 'task' } },
];

const PATHS = NOTES.map((note) => createVaultPath(note.path));
const resolveLink = (target: string) => resolveWikiLinkTarget(target, PATHS);

const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                      modified INTEGER, size INTEGER NOT NULL, progress INTEGER);
  CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                      value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
  CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                          target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
  CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);`);
for (const note of NOTES) {
  database
    .prepare('INSERT INTO files VALUES (?, ?, ?, 1, 1, ?)')
    .run(note.path, note.path.replace(/\.md$/, ''), '', note.progress);
  for (const row of indexablePropertiesOf(note.frontmatter)) {
    database
      .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(note.path, row.key, row.index, row.text, row.number, row.date, row.json);
  }
  for (const row of relationsOf(note.frontmatter, resolveLink)) {
    database
      .prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)')
      .run(note.path, row.key, row.index, row.target, row.name, row.path);
  }
}

function run(text: string): Record<string, unknown>[] {
  const compiled = compileAtlasQuery(parseAtlasQuery(text), { types: TYPES, resolveLink });
  return database.prepare(compiled.sql).all(...compiled.parameters) as Record<string, unknown>[];
}

const titles = (text: string) => run(text).map((row) => row['title']);

describe('progress in a DFAI query', () => {
  it('compares as a number', () => {
    expect(titles('FROM task WHERE progress >= 40')).toEqual(['Book the hall', 'Order chairs']);
    expect(titles('FROM task WHERE progress < 40')).toEqual(['Ring Mara']);
    expect(titles('FROM task WHERE progress = 100')).toEqual(['Order chairs']);
  });

  it('is empty for a note with no checklist, and 0 is not empty', () => {
    expect(titles('FROM task WHERE progress IS EMPTY')).toEqual(['Plain']);
    expect(titles('FROM task WHERE progress IS NOT EMPTY')).toEqual([
      'Book the hall',
      'Order chairs',
      'Ring Mara',
    ]);
  });

  it('sorts by number, a note with none last', () => {
    expect(titles('FROM task SORT BY progress DESC')).toEqual([
      'Order chairs',
      'Book the hall',
      'Ring Mara',
      'Plain',
    ]);
  });

  it('is shown as its number when the query mentions it', () => {
    const rows = run('FROM task WHERE progress > 0');
    expect(rows.map((row) => row['progress'])).toEqual([40, 100]);
  });

  it('is read through a relation from the note it points at', () => {
    expect(titles('FROM task WHERE project.progress = 50')).toEqual(['Book the hall']);
  });
});
