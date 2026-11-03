import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { relationsOf } from '../index/relation-rows.ts';
import { resolveWikiLinkTarget } from '../markdown/resolve-wikilink.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';
import { QUERY_TEST_TYPES } from './query-fixtures.ts';

/**
 * A query reads the vault's own notes only (A24-02): not DFAI's `.atlas`, not
 * a note in a hidden folder — as a row, or one relation hop away. The index
 * leaves hidden folders out already (refreshIndex lists user space), so here
 * they are put in on purpose: the query must hold the rule by itself.
 */
interface Note {
  readonly path: string;
  readonly title: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

const NOTES: readonly Note[] = [
  { path: 'people/Julie.md', title: 'Julie', frontmatter: { type: 'person', role: 'lead' } },
  { path: '.trash/Ghost.md', title: 'Aaa ghost', frontmatter: { type: 'person', role: 'trashed' } },
  {
    path: '.atlas/templates/Person.md',
    title: 'Aab template',
    frontmatter: { type: 'person', role: 'template' },
  },
  { path: 'node_modules/p/Person.md', title: 'Aac pruned', frontmatter: { type: 'person' } },
  { path: 'x/.hidden/Deep.md', title: 'Aad deep', frontmatter: { type: 'person' } },
  { path: 'projects/Seen.md', title: 'Seen', frontmatter: { type: 'project', owner: '[[Julie]]' } },
  {
    path: 'projects/Trashed.md',
    title: 'Trashed',
    frontmatter: { type: 'project', owner: '[[.trash/Ghost]]' },
  },
  {
    path: 'projects/Templated.md',
    title: 'Templated',
    frontmatter: { type: 'project', owner: '[[.atlas/templates/Person]]' },
  },
];

const PATHS = NOTES.map((note) => createVaultPath(note.path));
const resolveLink = (target: string) => resolveWikiLinkTarget(target, PATHS);

function buildIndex(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);`);
  for (const note of NOTES) {
    database.prepare('INSERT INTO files VALUES (?, ?, ?, 1, 1)').run(note.path, note.title, '');
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
  return database;
}

const database = buildIndex();

function run(text: string): Record<string, unknown>[] {
  const compiled = compileAtlasQuery(parseAtlasQuery(text), {
    types: QUERY_TEST_TYPES,
    resolveLink,
  });
  return database.prepare(compiled.sql).all(...compiled.parameters) as Record<string, unknown>[];
}

describe('compileAtlasQuery reads user space only', () => {
  it('lists no note from .atlas, a hidden folder or a pruned one, at any depth', () => {
    expect(run('FROM person SORT BY title').map((row) => row['path'])).toEqual(['people/Julie.md']);
  });

  it('shows nothing of a hidden or .atlas note one hop away', () => {
    const rows = run('FROM project SORT BY title SHOW owner.role, owner.title');
    expect(rows.map((row) => [row['title'], row['owner.role'], row['owner.title']])).toEqual([
      ['Seen', 'lead', 'Julie'],
      ['Templated', null, null],
      ['Trashed', null, null],
    ]);
  });

  it('cannot use WHERE on a hop to learn a hidden note’s values', () => {
    expect(run('FROM project WHERE owner.role = "trashed"')).toEqual([]);
    expect(run('FROM project WHERE owner.role = "template"')).toEqual([]);
    expect(
      run('FROM project WHERE owner.role IS EMPTY SORT BY title').map((r) => r['title']),
    ).toEqual(['Templated', 'Trashed']);
  });

  it('sorts by a relation as its link is written when the note it names is hidden', () => {
    // By the hidden notes' titles it would be "Aaa ghost", "Aab template",
    // "Julie"; as written, it is `.atlas/templates/Person`, `.trash/Ghost`, `Julie`.
    const titles = run('FROM project SORT BY owner, title').map((row) => row['title']);
    expect(titles).toEqual(['Templated', 'Trashed', 'Seen']);
  });
});
