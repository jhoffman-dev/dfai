import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { relationsOf } from '../index/relation-rows.ts';
import { resolveWikiLinkTarget } from '../markdown/resolve-wikilink.ts';
import { parseObjectType } from '../types/property-def.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { compileAtlasQuery } from './compile.ts';
import { queryableFields } from './fields.ts';
import { parseAtlasQuery } from './parse.ts';

/**
 * A relation to a project or an area (P30-01), one hop away: `project.<field>`
 * reaches any field either type declares, and reads it on whichever note is
 * linked — a note of a type that does not declare it has no value there.
 */

const TYPES = [
  parseObjectType({
    name: 'task',
    properties: { project: { kind: 'relation', target: ['project', 'area'] } },
  }),
  parseObjectType({ name: 'project', properties: { status: 'select', due: 'date' } }),
  parseObjectType({ name: 'area', properties: { steward: 'text', status: 'text' } }),
];

const NOTES = [
  { path: 'Projects/DFAI.md', title: 'DFAI', frontmatter: { type: 'project', status: 'active' } },
  { path: 'Areas/Garden.md', title: 'Garden', frontmatter: { type: 'area', steward: 'Mara' } },
  { path: 'Tasks/Ship.md', title: 'Ship', frontmatter: { type: 'task', project: '[[DFAI]]' } },
  { path: 'Tasks/Weed.md', title: 'Weed', frontmatter: { type: 'task', project: '[[Garden]]' } },
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
  const compiled = compileAtlasQuery(parseAtlasQuery(text), { types: TYPES, resolveLink });
  return database.prepare(compiled.sql).all(...compiled.parameters) as Record<string, unknown>[];
}

describe('a hop through a relation to a project or an area', () => {
  it('reaches the fields either type declares, each once, the first type deciding its kind', () => {
    const through = queryableFields(TYPES, ['task']).filter((field) => field.via === 'project');
    const keys = through.map((field) => field.text);
    expect(keys).toEqual(
      expect.arrayContaining(['project.status', 'project.due', 'project.steward']),
    );
    expect(keys.filter((key) => key === 'project.status')).toHaveLength(1);
    expect(through.find((field) => field.text === 'project.status')?.kind).toBe('select');
  });

  it('finds a task by a field only an area has', () => {
    expect(run('FROM task WHERE project.steward = "Mara"').map((row) => row['title'])).toEqual([
      'Weed',
    ]);
  });

  it('reads the field on whichever note is linked, empty where its type has none', () => {
    const rows = run('FROM task SORT BY title SHOW project.status, project.steward');
    expect(
      rows.map((row) => [row['title'], row['project.status'], row['project.steward']]),
    ).toEqual([
      ['Ship', 'active', null],
      ['Weed', null, 'Mara'],
    ]);
  });

  it('names both types when neither has the field', () => {
    expect(() => run('FROM task WHERE project.budget = 3')).toThrow(
      'A project or area has no field called budget.',
    );
  });
});
