import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { compileLinkHoldersQuery, relationsOf } from '../index/relation-rows.ts';
import { resolveWikiLinkTarget } from '../markdown/resolve-wikilink.ts';
import { toBoardRows } from '../query/group-rows.ts';
import { tagKey } from '../tags/tag-name.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';
import { QUERY_TEST_TYPES } from './query-fixtures.ts';
import { groupResultRows } from './result-groups.ts';

/**
 * Adversarial, second pass over Phase 24: compiled queries run against SQLite
 * over the index's tables, filled the way refreshing the index fills them.
 */
interface Note {
  readonly path: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly tags?: readonly string[];
  readonly modified?: number;
}

const MIDDAY = Date.UTC(2999, 0, 1, 12);

const SCHEMA = `
  CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                      modified INTEGER, size INTEGER NOT NULL);
  CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                      value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
  CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                          target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
  CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE links (src TEXT NOT NULL, dst TEXT, target TEXT NOT NULL, kind TEXT NOT NULL,
                      leaf TEXT NOT NULL DEFAULT '');`;

function indexOf(notes: readonly Note[]) {
  const paths = notes.map((note) => createVaultPath(note.path));
  const resolveLink = (target: string) => resolveWikiLinkTarget(target, paths);
  const database = new DatabaseSync(':memory:');
  database.exec(SCHEMA);
  for (const note of notes) {
    const title = note.path.replace(/^.*\//, '').replace(/\.md$/, '');
    database
      .prepare('INSERT INTO files VALUES (?, ?, ?, ?, 1)')
      .run(note.path, title, '', note.modified ?? MIDDAY);
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
  return { run, titles, groups, database };
}

const task = (
  name: string,
  frontmatter: Record<string, unknown>,
  extra: Partial<Note> = {},
): Note => ({
  path: `tasks/${name}.md`,
  frontmatter: { type: 'task', ...frontmatter },
  ...extra,
});

describe('sorting keeps the time a value holds (adversarial)', () => {
  it('sorts two due dates on the same day by their time', () => {
    // Why: the sort key is date(p.value_date), which drops the time — the two tie
    // and fall back to the title, so the 18:00 task is listed before the 09:00 one.
    const index = indexOf([
      task('A evening', { due: '2026-09-30T18:00' }),
      task('B morning', { due: '2026-09-30T09:00' }),
    ]);
    expect(index.titles('FROM task SORT BY due')).toEqual(['B morning', 'A evening']);
  });

  it('sorts by modified to the moment, not to the day', () => {
    // Why: modified sorts by date(… 'localtime'): every note changed today ties,
    // so "SORT BY modified DESC" does not put the latest edit first.
    const index = indexOf([
      task('A older', {}, { modified: Date.UTC(2026, 8, 30, 12, 0) }),
      task('B newer', {}, { modified: Date.UTC(2026, 8, 30, 12, 1) }),
    ]);
    expect(index.titles('FROM task SORT BY modified DESC')).toEqual(['B newer', 'A older']);
  });
});

describe('a date compares by the day it was written (adversarial)', () => {
  it('matches a due date written with a UTC offset on its own day', () => {
    // Why: date('2026-09-30T22:00-05:00') in SQLite is the UTC day, 2026-10-01; the
    // note says the 30th, and its cell shows the 30th, but "due = 2026-09-30" misses it.
    const index = indexOf([task('Late call', { due: '2026-09-30T22:00-05:00' })]);
    expect(index.titles('FROM task WHERE due = 2026-09-30')).toEqual(['Late call']);
  });
});

describe('tags shown through a relation keep their written order (adversarial)', () => {
  it('lists a project’s tags in the order the project writes them', () => {
    // Why: the tag cell orders by MIN(h.idx, g.idx, g.rowid) — the scalar MIN of
    // three columns, which is h.idx (0) for every tag, so the order is SQLite's
    // GROUP BY order (alphabetical), not the order written.
    const index = indexOf([
      { path: 'projects/DFAI.md', frontmatter: { type: 'project' }, tags: ['zeta', 'alpha'] },
      task('Write', { project: '[[DFAI]]' }),
    ]);
    const { objects } = index.run('FROM task SHOW project.tag');
    expect(objects[0]?.['project.tag']).toBe('#zeta, #alpha');
  });
});

describe('grouping by a number (adversarial)', () => {
  it('puts the groups in numeric order', () => {
    // Why: undeclared values are ordered by localeCompare on their label, so 10 comes before 9.
    const index = indexOf([
      task('Ten', { estimate: 10 }),
      task('Nine', { estimate: 9 }),
      task('Minus', { estimate: -1 }),
    ]);
    expect(index.groups('FROM task GROUP BY estimate').map((group) => group.label)).toEqual([
      '-1',
      '9',
      '10',
    ]);
  });
});

describe('grouping by the field the query sorts by (adversarial)', () => {
  it('puts the groups in the order the query sorts them', () => {
    // Why: groups that are not a select's options are ordered by localeCompare on
    // their label, whatever the query asked: SORT BY due DESC still lists the
    // earliest day first.
    const index = indexOf([
      task('Early', { due: '2026-09-01' }),
      task('Late', { due: '2026-10-01' }),
    ]);
    expect(index.titles('FROM task SORT BY due DESC GROUP BY due')).toEqual(['Late', 'Early']);
    const groups = index.groups('FROM task SORT BY due DESC GROUP BY due');
    expect(groups.map((group) => group.label)).toEqual(['2026-10-01', '2026-09-01']);
  });
});

describe('grouping by a checkbox (adversarial)', () => {
  it('puts a note that never had the box with the unticked ones', () => {
    // Why: ADR-0019 — "an unticked checkbox is anything but true", so
    // "flagged = false" lists both notes; grouped by flagged, the one without the
    // property lands in "No value" instead of beside the one written false.
    const index = indexOf([task('Unset', {}), task('Unticked', { flagged: false })]);
    expect(index.titles('FROM task WHERE flagged = false')).toEqual(['Unset', 'Unticked']);
    const groups = index.groups('FROM task GROUP BY flagged');
    expect(groups.map((group) => group.rows.map((row) => row.title))).toEqual([
      ['Unset', 'Unticked'],
    ]);
  });
});

describe('a long query the check lets through (adversarial)', () => {
  it('runs a thousand conditions joined by OR, as the check promises it can', () => {
    // Why: ADR-0019 — "A query that passes compiles to SQL the index can run". The
    // parser caps nesting at 64, but a flat chain is one level to it and a
    // left-deep tree to SQLite, whose expression depth limit is 1000.
    const index = indexOf([task('A', { notes: 'x' })]);
    const chain = Array.from({ length: 1000 }, (_, at) => `notes = v${at}`).join(' OR ');
    expect(index.titles(`FROM task WHERE ${chain} OR notes = x`)).toEqual(['A']);
  });
});

describe('the longest query the check lets through', () => {
  it('runs two thousand conditions joined by AND and OR', () => {
    const index = indexOf([task('A', { notes: 'x', estimate: 3 })]);
    const ors = Array.from({ length: 999 }, (_, at) => `notes = v${at}`).join(' OR ');
    const ands = Array.from({ length: 1000 }, () => 'estimate > 1').join(' AND ');
    expect(index.titles(`FROM task WHERE (${ors} OR notes = x) AND ${ands}`)).toEqual(['A']);
  });
});

describe('sorting', () => {
  it('reads each sort value once', () => {
    // Why: the sort's first-value subquery was written twice, once to put blanks last.
    const { compiled } = indexOf([]).run('FROM task SORT BY due SHOW title');
    expect(compiled.parameters.filter((value) => value === 'due')).toHaveLength(1);
  });

  it('puts a note without the value last, whichever way it sorts', () => {
    const index = indexOf([
      task('Blank', {}),
      task('Early', { due: '2026-09-01' }),
      task('Late', { due: '2026-10-01 08:00' }),
    ]);
    expect(index.titles('FROM task SORT BY due')).toEqual(['Early', 'Late', 'Blank']);
    expect(index.titles('FROM task SORT BY due DESC')).toEqual(['Late', 'Early', 'Blank']);
  });

  it('sorts a time written with a space beside one written with a T', () => {
    const index = indexOf([
      task('Evening', { due: '2026-09-30 18:00' }),
      task('Morning', { due: '2026-09-30T09:00' }),
    ]);
    expect(index.titles('FROM task SORT BY due')).toEqual(['Morning', 'Evening']);
  });
});

describe('grouping by a date', () => {
  it('puts the days in date order unless the query sorts that field the other way', () => {
    const index = indexOf([
      task('Late', { due: '2026-10-01' }),
      task('Early', { due: '2026-09-01' }),
    ]);
    const labels = (text: string) => index.groups(text).map((group) => group.label);
    expect(labels('FROM task GROUP BY due')).toEqual(['2026-09-01', '2026-10-01']);
    expect(labels('FROM task SORT BY title DESC GROUP BY due')).toEqual([
      '2026-09-01',
      '2026-10-01',
    ]);
  });
});

describe('grouping by a checkbox', () => {
  it('puts the ticked first and everything else with the unticked', () => {
    const index = indexOf([
      task('Unset', {}),
      task('Ticked', { flagged: true }),
      task('Odd', { flagged: 'maybe' }),
    ]);
    const groups = index.groups('FROM task GROUP BY flagged');
    expect(groups.map((group) => [group.label, group.rows.map((row) => row.title)])).toEqual([
      ['true', ['Ticked']],
      ['false', ['Odd', 'Unset']],
    ]);
  });
});

describe('a relation to a note that does not exist yet', () => {
  it('matches a link written in another case, outside ASCII, as links match it', () => {
    // Why: the fallback compared lower(r.target) with lower(?), and SQLite's
    // lower() leaves É alone — [[École]] never matched [[école]].
    const index = indexOf([task('Visit', { project: '[[École]]' })]);
    expect(index.titles('FROM task WHERE project = [[école]]')).toEqual(['Visit']);
  });
});

describe('the relations a new or removed note makes stale (adversarial)', () => {
  const holders = (rows: readonly { src: string; target: string }[], changedPath: string) => {
    const database = new DatabaseSync(':memory:');
    database.exec(SCHEMA);
    for (const row of rows) {
      // Written as refreshing the index writes it: the name folded in TypeScript.
      const [relation] = relationsOf({ project: `[[${row.target}]]` }, () => null);
      database
        .prepare('INSERT INTO relations (src, key, idx, target, name) VALUES (?, ?, 0, ?, ?)')
        .run(row.src, 'project', row.target, relation?.name ?? '');
    }
    const { sql, parameters } = compileLinkHoldersQuery({ made: [changedPath], gone: [] });
    return (database.prepare(sql).all(...parameters) as { path: string }[]).map((row) => row.path);
  };

  it('finds a relation written with the file extension, which resolves to the new note', () => {
    // Why: [[Later.md]] resolves to Later.md (resolveWikiLinkTarget strips .md), but the
    // holders query compares "later.md" with "later", so the holder keeps dst = NULL
    // and "project = [[Later]]" never finds it after Later.md is made.
    expect(resolveWikiLinkTarget('Later.md', [createVaultPath('Later.md')])).toBe('Later.md');
    expect(holders([{ src: 'tasks/t.md', target: 'Later.md' }], 'Later.md')).toEqual([
      'tasks/t.md',
    ]);
  });

  it('finds a relation to a note whose name has a letter outside ASCII', () => {
    // Why: linkedName lower-cases with JavaScript ("école"), the SQL with SQLite's
    // lower(), which leaves "É" alone — [[École]] is never re-resolved.
    expect(holders([{ src: 'tasks/t.md', target: 'École' }], 'people/École.md')).toEqual([
      'tasks/t.md',
    ]);
  });

  it('finds a relation written in decomposed form to a note named in composed form', () => {
    // Why: links resolve after Unicode composition (NFC); the holders query compares the raw strings.
    const decomposed = 'Café';
    expect(resolveWikiLinkTarget(decomposed, [createVaultPath('Café.md')])).not.toBeNull();
    expect(holders([{ src: 'tasks/t.md', target: decomposed }], 'Café.md')).toEqual(['tasks/t.md']);
  });
});
