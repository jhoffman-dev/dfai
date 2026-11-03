import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { relationsOf } from '../index/relation-rows.ts';
import { resolveWikiLinkTarget } from '../markdown/resolve-wikilink.ts';
import { toBoardRows } from '../query/group-rows.ts';
import { tagKey } from '../tags/tag-name.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';
import { QUERY_TEST_TYPES } from './query-fixtures.ts';
import { groupResultRows } from './result-groups.ts';

/**
 * Adversarial: compiled queries run against SQLite over the index's tables,
 * filled the way refreshing the index fills them (the same harness as
 * compile.sqlite.test.ts, but each test builds the few notes it needs).
 */
interface Note {
  readonly path: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly tags?: readonly string[];
}

const MIDDAY = Date.UTC(2999, 0, 1, 12);

function indexOf(notes: readonly Note[]) {
  const paths = notes.map((note) => createVaultPath(note.path));
  const resolveLink = (target: string) => resolveWikiLinkTarget(target, paths);
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);`);
  for (const note of notes) {
    const title = note.path.replace(/^.*\//, '').replace(/\.md$/, '');
    database.prepare('INSERT INTO files VALUES (?, ?, ?, ?, 1)').run(note.path, title, '', MIDDAY);
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
    (note.tags ?? []).forEach((name, at) =>
      database
        .prepare('INSERT INTO tags VALUES (?, ?, ?, ?)')
        .run(note.path, at, tagKey(name), name),
    );
  }
  const run = (text: string) => {
    const compiled = compileAtlasQuery(parseAtlasQuery(text), {
      types: QUERY_TEST_TYPES,
      resolveLink,
    });
    const objects = database.prepare(compiled.sql).all(...compiled.parameters) as Record<
      string,
      unknown
    >[];
    return { compiled, objects };
  };
  const titles = (text: string) => run(text).objects.map((row) => row['title']);
  const groups = (text: string) => {
    const { compiled, objects } = run(text);
    const columns = objects[0] === undefined ? [] : Object.keys(objects[0]);
    const rows = toBoardRows({
      columns,
      rows: objects.map((object) => columns.map((column) => object[column])),
    });
    return groupResultRows({ rows, groups: compiled.groups });
  };
  return { titles, groups };
}

const task = (name: string, frontmatter: Record<string, unknown>): Note => ({
  path: `tasks/${name}.md`,
  frontmatter: { type: 'task', ...frontmatter },
});

describe('CONTAINS and STARTS WITH ignore case (adversarial)', () => {
  // A known limit (ADR-0019): SQLite's lower() folds A–Z only, and the index is
  // not given a folding function of its own. Kept as a test that is expected to
  // fail, so the day it passes is noticed.
  it.fails('ignores the case of a letter outside ASCII', () => {
    // Why: SQLite's built-in lower() folds only A–Z, so "école" never finds "École" — ADR-0019 says case is ignored.
    const index = indexOf([task('École plans', {}), task('Other', {})]);
    expect(index.titles('FROM task WHERE title CONTAINS École')).toEqual(['École plans']);
    expect(index.titles('FROM task WHERE title CONTAINS école')).toEqual(['École plans']);
  });

  it.fails('ignores the case of a Greek word in a text property', () => {
    // Why: same ASCII-only lower(); a note written in any non-Latin script cannot be searched case-blind.
    const index = indexOf([task('A', { notes: 'Ωμέγα' })]);
    expect(index.titles('FROM task WHERE notes STARTS WITH Ωμέγα')).toEqual(['A']);
    expect(index.titles('FROM task WHERE notes STARTS WITH ωμέγα')).toEqual(['A']);
  });
});

describe('a number written as a text value keeps its spelling (adversarial)', () => {
  it('matches a text value 1.0 written bare', () => {
    // Why: the token becomes Number("1.0") and is bound as String(1) = "1", so it never equals the stored "1.0".
    const index = indexOf([task('Versioned', { notes: '1.0' })]);
    expect(index.titles("FROM task WHERE notes = '1.0'")).toEqual(['Versioned']);
    expect(index.titles('FROM task WHERE notes = 1.0')).toEqual(['Versioned']);
  });

  it('matches a code with leading zeros written bare', () => {
    // Why: 007 is bound as "7".
    const index = indexOf([task('Bond', { notes: '007' })]);
    expect(index.titles("FROM task WHERE notes = '007'")).toEqual(['Bond']);
    expect(index.titles('FROM task WHERE notes = 007')).toEqual(['Bond']);
  });
});

describe('SORT BY puts blanks last (adversarial)', () => {
  it('puts a blank string after the values, as it does a missing one', () => {
    // Why: only NULL is sorted last; "" is a value to ORDER BY and comes first, though IS EMPTY calls it blank.
    const index = indexOf([
      task('Has', { notes: 'alpha' }),
      task('Blank', { notes: '' }),
      task('Missing', {}),
    ]);
    expect(index.titles('FROM task WHERE notes IS EMPTY')).toEqual(['Blank', 'Missing']);
    const sorted = index.titles('FROM task SORT BY notes');
    expect(sorted[0]).toBe('Has');
  });
});

describe('SORT BY a relation (adversarial)', () => {
  it('sorts by the note linked, not by the folder written in the link', () => {
    // Why: a relation sorts by its raw value_text, so [[people/Aaron]] sorts under "p", after [[Bob]].
    const index = indexOf([
      { path: 'people/Aaron.md', frontmatter: { type: 'person' } },
      { path: 'people/Bob.md', frontmatter: { type: 'person' } },
      task('One', { owner: '[[Bob]]' }),
      task('Two', { owner: '[[people/Aaron]]' }),
    ]);
    expect(index.titles('FROM task SORT BY owner')).toEqual(['Two', 'One']);
  });
});

describe('GROUP BY a field with several values (adversarial)', () => {
  it('never makes a group out of two values joined together', () => {
    // Why: the grouped column is group_concat'ed, so labels [red, blue] lands in a group called "red, blue" that is no option.
    const index = indexOf([
      task('Both', { labels: ['red', 'blue'] }),
      task('Red', { labels: ['red'] }),
    ]);
    // Decided in review: a note sits in one group, so a field with several values is refused.
    expect(() => index.groups('FROM task GROUP BY labels')).toThrow('cannot be grouped');
  });
});

describe('GROUP BY a relation (adversarial)', () => {
  // A known limit: a relation's groups are the board's columns (group-rows.ts),
  // keyed by the note's name; changing that changes every board. Expected to fail.
  it.fails('keeps two different notes that share a name in two groups', () => {
    // Why: relation groups are keyed by the lower-cased last path segment, so work/Plan and home/Plan merge.
    const index = indexOf([
      { path: 'work/Plan.md', frontmatter: { type: 'project' } },
      { path: 'home/Plan.md', frontmatter: { type: 'project' } },
      task('A', { project: '[[work/Plan]]' }),
      task('B', { project: '[[home/Plan]]' }),
    ]);
    expect(index.groups('FROM task GROUP BY project')).toHaveLength(2);
  });
});

describe('a link that points nowhere (adversarial)', () => {
  it('matches the same link written with spaces inside the brackets', () => {
    // Why: the query trims its link target, relationsOf stores it untrimmed, and the fallback compares them exactly.
    const index = indexOf([task('Spaced', { project: '[[ Nowhere ]]' })]);
    expect(index.titles('FROM task WHERE project CONTAINS Nowhere')).toEqual(['Spaced']);
    expect(index.titles('FROM task WHERE project = [[Nowhere]]')).toEqual(['Spaced']);
  });
});
