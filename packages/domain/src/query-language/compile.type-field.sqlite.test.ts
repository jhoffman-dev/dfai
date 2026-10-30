import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { relationsOf } from '../index/relation-rows.ts';
import { parseObjectType } from '../types/property-def.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';
import { QueryTextError } from './query-text-error.ts';

/**
 * The built-in `type` field reads a note's type as FROM does (follow-up to
 * #110): in any case and spacing, and every type a note lists. Run against
 * SQLite, with the person page's Linked notes plan (linked-sections.ts) as
 * the case that showed the two parting.
 */
const MARA = 'people/Mara Quill.md';

const TYPES = [
  parseObjectType({
    name: 'meeting',
    properties: { attendees: { kind: 'relation', target: 'person', many: true } },
  }),
  parseObjectType({ name: 'person', properties: {} }),
  parseObjectType({ name: 'project', properties: {} }),
];

const NOTES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  [MARA]: { type: 'person' },
  'meetings/Kickoff.md': { type: 'Meeting', attendees: ['[[Mara Quill]]'] },
  'meetings/Review.md': { type: 'meeting', attendees: ['[[Mara Quill]]'] },
  'meetings/Both.md': { type: ['project', 'meeting'], attendees: ['[[Mara Quill]]'] },
  'projects/Shed.md': { type: ' PROJECT ', owner: '[[Mara Quill]]' },
};

const resolve = (target: string) => (target === 'Mara Quill' ? MARA : null);

const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                      modified INTEGER NOT NULL, size INTEGER NOT NULL);
  CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                      value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
  CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                          target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
  CREATE TABLE links (src TEXT NOT NULL, dst TEXT, target TEXT NOT NULL, kind TEXT NOT NULL,
                      leaf TEXT NOT NULL DEFAULT '');`);
for (const [path, frontmatter] of Object.entries(NOTES)) {
  const title = path.replace(/^.*\//, '').replace(/\.md$/, '');
  database.prepare('INSERT INTO files VALUES (?, ?, ?, 0, 1)').run(path, title, '');
  for (const row of indexablePropertiesOf(frontmatter)) {
    database
      .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
  }
  for (const row of relationsOf(frontmatter, resolve)) {
    database
      .prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)')
      .run(path, row.key, row.index, row.target, row.name, row.path);
  }
}

function titles(text: string, types = TYPES): string[] {
  const compiled = compileAtlasQuery(parseAtlasQuery(text), {
    types,
    resolveLink: resolve,
    thisNote: MARA,
  });
  return database
    .prepare(compiled.sql)
    .all(...compiled.parameters)
    .map((row) => String(row['title']))
    .sort();
}

describe('the type field reads a type as FROM does', () => {
  it('keeps with type = meeting every note FROM meeting lists, in any case or in a list', () => {
    expect(titles('FROM meeting')).toEqual(['Both', 'Kickoff', 'Review']);
    expect(titles('FROM meeting WHERE type = meeting')).toEqual(['Both', 'Kickoff', 'Review']);
    expect(titles('FROM meeting WHERE type = Meeting')).toEqual(['Both', 'Kickoff', 'Review']);
  });

  it('drops with type != meeting every note FROM meeting lists', () => {
    expect(titles('FROM meeting WHERE type != meeting')).toEqual([]);
    expect(titles('FROM meeting, project WHERE type != meeting')).toEqual(['Shed']);
  });

  it('asks every type a note lists', () => {
    expect(titles('FROM meeting, project WHERE type = project')).toEqual(['Both', 'Shed']);
  });

  // linkedSectionPlans('person'): a meeting Mara attends is under Meetings, so
  // Linked notes leaves it out — whatever case its type is written in.
  it("leaves a meeting Mara attends out of her page's Linked notes, in any case", () => {
    expect(titles('FROM meeting WHERE attendees = this')).toEqual(['Both', 'Kickoff', 'Review']);
    expect(
      titles(
        'FROM meeting, person, project WHERE CONNECTED TO this AND NOT (type = meeting AND attendees = this)',
      ),
    ).toEqual(['Shed']);
  });
});

describe('two types whose names differ only in case', () => {
  const twice = [...TYPES, parseObjectType({ name: 'Meeting', properties: {} })];

  it('are refused by name, since FROM would read one set of notes through both', () => {
    expect(() => titles('FROM meeting', twice)).toThrow(QueryTextError);
    expect(() => titles('FROM meeting', twice)).toThrow(
      'Two types are called meeting: meeting and Meeting. Rename one, so meeting names one type.',
    );
  });

  it('leave a query that names neither alone', () => {
    expect(titles('FROM person', twice)).toEqual(['Mara Quill']);
  });
});
