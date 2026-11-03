import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { relationsOf } from '../index/relation-rows.ts';
import { resolveWikiLinkTarget } from '../markdown/resolve-wikilink.ts';
import { tagKey } from '../tags/tag-name.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';
import { QUERY_TEST_TYPES } from './query-fixtures.ts';

/**
 * Compiled queries run for real, against SQLite, over the index's own tables
 * — `files`, `props`, `relations`, `tags` — filled the way refreshing the
 * index fills them. What is asserted is the rows a person would see.
 */
interface Note {
  readonly path: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly tags?: readonly string[];
  readonly modified?: number;
}

const NOTES: readonly Note[] = [
  { path: 'people/Julie.md', frontmatter: { type: 'person', role: 'lead' } },
  { path: 'people/Sam.md', frontmatter: { type: 'person', role: 'hand' } },
  {
    path: 'projects/Atlas.md',
    frontmatter: { type: 'project', status: 'active', owner: '[[Julie]]', due: '2026-12-01' },
    tags: ['q3'],
  },
  {
    path: 'projects/Garden.md',
    frontmatter: { type: 'project', status: 'paused', owner: '[[people/Sam|Sam]]' },
  },
  {
    path: 'tasks/Write ADR.md',
    frontmatter: {
      type: 'task',
      status: 'doing',
      due: '2000-01-01',
      project: '[[Atlas]]',
      estimate: 3,
      flagged: true,
      labels: ['red', 'blue'],
      owner: '[[Julie]]',
    },
    tags: ['q3', 'Writing'],
    modified: Date.UTC(1999, 5, 1, 12),
  },
  {
    path: 'tasks/Ship.md',
    frontmatter: {
      type: 'task',
      status: 'done',
      due: '2999-01-01',
      project: '[[atlas]]',
      estimate: 10,
    },
    tags: ['q3'],
  },
  {
    path: 'tasks/Weed.md',
    frontmatter: {
      type: 'task',
      status: 'backlog',
      due: '2999-06-01T09:30',
      project: '[[Garden]]',
      estimate: 9,
      flagged: false,
    },
    tags: ['q3/okr'],
  },
  { path: 'tasks/Plan.md', frontmatter: { type: 'task', status: 'doing', notes: 'Plan the week' } },
  {
    path: 'tasks/Ghost.md',
    frontmatter: { type: 'task', status: 'doing', project: '[[Nowhere]]', labels: ['blue'] },
  },
  {
    path: 'Archive/tasks/Old.md',
    frontmatter: { type: 'task', status: 'doing', project: '[[Atlas]]' },
  },
  { path: '.atlas/templates/Task.md', frontmatter: { type: 'task', status: 'backlog' } },
  { path: 'notes/Idea.md', frontmatter: { status: 'doing' } },
];

/** Midday, so the day is the same in every time zone the tests might run in. */
const LATER = Date.UTC(2999, 0, 1, 12);

const PATHS = NOTES.map((note) => createVaultPath(note.path));
const resolveLink = (target: string) => resolveWikiLinkTarget(target, PATHS);

function buildIndex(notes: readonly Note[]): DatabaseSync {
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
    database
      .prepare('INSERT INTO files VALUES (?, ?, ?, ?, 1)')
      .run(note.path, title, '', note.modified ?? LATER);
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
  return database;
}

const database = buildIndex(NOTES);

function run(text: string): Record<string, unknown>[] {
  const compiled = compileAtlasQuery(parseAtlasQuery(text), {
    types: QUERY_TEST_TYPES,
    resolveLink,
  });
  return database.prepare(compiled.sql).all(...compiled.parameters) as Record<string, unknown>[];
}

const titles = (text: string) => run(text).map((row) => row['title']);

describe('compileAtlasQuery, run against SQLite: which notes', () => {
  it('answers the U-23 example: across types, through a relation, by a tag', () => {
    expect(
      titles(
        'FROM task, project WHERE status != done AND project.owner = [[Julie]] AND tag = #q3 SORT BY due GROUP BY project THEN status',
      ),
    ).toEqual(['Write ADR']);
  });

  it('lists every note of the listed types, and nothing Atlas keeps or has archived', () => {
    expect(titles('FROM task, project')).toEqual([
      'Atlas',
      'Garden',
      'Ghost',
      'Plan',
      'Ship',
      'Weed',
      'Write ADR',
    ]);
  });

  it('reaches into the Archive only when asked to', () => {
    expect(titles('FROM task WHERE status = doing')).not.toContain('Old');
    expect(titles('FROM task WHERE status = doing INCLUDE ARCHIVED')).toContain('Old');
  });

  it('leaves out a project archived by its PARA, where it stands, unless archived ones are asked for (#213)', () => {
    const shelved = buildIndex([
      ...NOTES,
      { path: 'projects/Shelved.md', frontmatter: { type: 'project', para: 'archive' } },
      { path: 'projects/Home.md', frontmatter: { type: 'project', para: 'area' } },
    ]);
    const listed = (text: string) => {
      const compiled = compileAtlasQuery(parseAtlasQuery(text), {
        types: QUERY_TEST_TYPES,
        resolveLink,
      });
      return shelved
        .prepare(compiled.sql)
        .all(...compiled.parameters)
        .map((row) => row['title']);
    };
    expect(listed('FROM project')).toContain('Home');
    expect(listed('FROM project')).not.toContain('Shelved');
    expect(listed('FROM project INCLUDE ARCHIVED')).toContain('Shelved');
  });

  it('gives each row the type it was listed as', () => {
    const rows = run('FROM task, project WHERE title STARTS WITH a OR title = Plan');
    expect(rows.map((row) => [row['title'], row['type']])).toEqual([
      ['Atlas', 'project'],
      ['Plan', 'task'],
    ]);
  });

  it('reads "is not" as "has no such value", so a note without one is listed', () => {
    expect(titles('FROM task WHERE due != 2000-01-01')).toEqual(['Ghost', 'Plan', 'Ship', 'Weed']);
  });

  it('tells empty from not empty', () => {
    expect(titles('FROM task WHERE due IS EMPTY')).toEqual(['Ghost', 'Plan']);
    expect(titles('FROM task WHERE project IS NOT EMPTY AND labels IS EMPTY')).toEqual([
      'Ship',
      'Weed',
    ]);
    expect(titles('FROM task WHERE tag IS EMPTY')).toEqual(['Ghost', 'Plan']);
  });

  it('compares numbers as numbers, not as text', () => {
    expect(titles('FROM task WHERE estimate > 4')).toEqual(['Ship', 'Weed']);
    expect(titles('FROM task WHERE estimate <= 3')).toEqual(['Write ADR']);
    expect(titles('FROM task WHERE estimate = 10')).toEqual(['Ship']);
  });

  it('compares dates by the day, time or none', () => {
    expect(titles('FROM task WHERE due = 2999-06-01')).toEqual(['Weed']);
    expect(titles('FROM task WHERE due >= 2999-01-01')).toEqual(['Ship', 'Weed']);
    expect(titles('FROM task WHERE due < 2999-06-01')).toEqual(['Ship', 'Write ADR']);
  });

  it('compares with a date that moves, today being between the two ends of the data', () => {
    expect(titles('FROM task WHERE due < @today')).toEqual(['Write ADR']);
    expect(titles('FROM task WHERE due > @weekAhead')).toEqual(['Ship', 'Weed']);
    expect(titles('FROM task WHERE modified < @weekAgo')).toEqual(['Write ADR']);
  });

  it('searches text without minding case, and anchors STARTS WITH', () => {
    expect(titles('FROM task WHERE notes CONTAINS WEEK')).toEqual(['Plan']);
    expect(titles('FROM task WHERE title STARTS WITH w')).toEqual(['Weed', 'Write ADR']);
    expect(titles('FROM task WHERE title STARTS WITH adr')).toEqual([]);
    expect(titles("FROM task WHERE title CONTAINS '%'")).toEqual([]);
  });

  it('reads an unticked checkbox as anything but ticked', () => {
    expect(titles('FROM task WHERE flagged = true')).toEqual(['Write ADR']);
    expect(titles('FROM task WHERE flagged = false')).toEqual(['Ghost', 'Plan', 'Ship', 'Weed']);
    expect(titles('FROM task WHERE flagged != true')).toEqual(
      titles('FROM task WHERE flagged = false'),
    );
    expect(titles('FROM task WHERE flagged != false')).toEqual(['Write ADR']);
  });

  it('matches any one of several values', () => {
    expect(titles('FROM task WHERE labels = blue')).toEqual(['Ghost', 'Write ADR']);
    expect(titles('FROM task WHERE labels != red')).toEqual(['Ghost', 'Plan', 'Ship', 'Weed']);
  });

  it('finds a tag and every tag nested under it, whatever case it was written in', () => {
    expect(titles('FROM task WHERE tag = #q3')).toEqual(['Ship', 'Weed', 'Write ADR']);
    expect(titles('FROM task WHERE tag = #Q3/OKR')).toEqual(['Weed']);
    expect(titles('FROM task WHERE tag = writing')).toEqual(['Write ADR']);
    expect(titles('FROM task WHERE tag != #q3')).toEqual(['Ghost', 'Plan']);
  });

  it('does not take a tag that only starts with the same letters for a nested one', () => {
    expect(titles('FROM task WHERE tag = #q')).toEqual([]);
  });

  it('matches a relation by the note it points at, however the link is spelled', () => {
    expect(titles('FROM task WHERE project = [[Atlas]]')).toEqual(['Ship', 'Write ADR']);
    expect(titles('FROM task WHERE project = [[projects/Atlas|the app]]')).toEqual([
      'Ship',
      'Write ADR',
    ]);
    expect(titles('FROM task WHERE project = Atlas')).toEqual(['Ship', 'Write ADR']);
    expect(titles('FROM task WHERE project != [[Atlas]]')).toEqual(['Ghost', 'Plan', 'Weed']);
  });

  it('matches a link to a note that does not exist by how it is written', () => {
    expect(titles('FROM task WHERE project = [[nowhere]]')).toEqual(['Ghost']);
  });

  it('searches a relation’s target as written', () => {
    expect(titles('FROM task WHERE project CONTAINS ard')).toEqual(['Weed']);
    expect(titles('FROM task WHERE project STARTS WITH at')).toEqual(['Ship', 'Write ADR']);
  });

  it('reaches one hop through a relation, to properties, tags and titles', () => {
    expect(titles('FROM task WHERE project.status = active')).toEqual(['Ship', 'Write ADR']);
    expect(titles('FROM task WHERE project.owner = [[Sam]]')).toEqual(['Weed']);
    expect(titles('FROM task WHERE project.tag = #q3')).toEqual(['Ship', 'Write ADR']);
    expect(titles('FROM task WHERE project.title CONTAINS gar')).toEqual(['Weed']);
    expect(titles('FROM task WHERE project.due > 2026-11-01')).toEqual(['Ship', 'Write ADR']);
    expect(titles('FROM task WHERE project.status IS EMPTY')).toEqual(['Ghost', 'Plan']);
  });

  it('asks about the type and the path like any other field', () => {
    expect(titles('FROM task, project WHERE type = project')).toEqual(['Atlas', 'Garden']);
    expect(titles("FROM task WHERE path STARTS WITH 'tasks/W'")).toEqual(['Weed', 'Write ADR']);
  });

  it('combines conditions with AND, OR, NOT and brackets', () => {
    expect(titles('FROM task WHERE status = done OR estimate = 9')).toEqual(['Ship', 'Weed']);
    expect(titles('FROM task WHERE NOT (status = doing OR status = done)')).toEqual(['Weed']);
    expect(
      titles(
        'FROM task WHERE (status = doing OR status = done) AND project = [[Atlas]] AND NOT flagged = true',
      ),
    ).toEqual(['Ship']);
  });

  it('stops at LIMIT', () => {
    expect(titles('FROM task LIMIT 2')).toEqual(['Ghost', 'Plan']);
  });
});

describe('compileAtlasQuery, run against SQLite: order', () => {
  it('sorts by a date, blanks last whichever way', () => {
    expect(titles('FROM task SORT BY due')).toEqual(['Write ADR', 'Ship', 'Weed', 'Ghost', 'Plan']);
    expect(titles('FROM task SORT BY due DESC')).toEqual([
      'Weed',
      'Ship',
      'Write ADR',
      'Ghost',
      'Plan',
    ]);
  });

  it('sorts numbers as numbers: 9 before 10', () => {
    expect(titles('FROM task WHERE estimate IS NOT EMPTY SORT BY estimate')).toEqual([
      'Write ADR',
      'Weed',
      'Ship',
    ]);
  });

  it('sorts by several keys, then by title, then by path', () => {
    expect(titles('FROM task SORT BY status, estimate DESC')).toEqual([
      'Weed',
      'Write ADR',
      'Ghost',
      'Plan',
      'Ship',
    ]);
  });

  it('sorts by a field through a relation', () => {
    // Ghost's project is a note that does not exist, so it has no title: blank, last.
    expect(
      titles('FROM task WHERE project IS NOT EMPTY SORT BY project.title DESC, title'),
    ).toEqual(['Weed', 'Ship', 'Write ADR', 'Ghost']);
  });
});

describe('compileAtlasQuery, run against SQLite: columns', () => {
  it('starts every row with path, title and type, then the fields the query mentions', () => {
    const [row] = run('FROM task WHERE estimate = 3 SORT BY due GROUP BY status');
    expect(Object.keys(row ?? {})).toEqual(['path', 'title', 'type', 'status', 'due', 'estimate']);
  });

  it('shows what SHOW names, the group fields after it', () => {
    const [row] = run(
      'FROM task WHERE estimate = 3 SHOW labels, tag, project.owner, title GROUP BY project',
    );
    expect(row).toEqual({
      path: 'tasks/Write ADR.md',
      title: 'Write ADR',
      type: 'task',
      labels: 'red, blue',
      tag: '#q3, #Writing',
      'project.owner': '[[Julie]]',
      project: '[[Atlas]]',
    });
  });

  it('keeps a number a number and a date as it was written', () => {
    const [row] = run('FROM task WHERE title = Weed SHOW estimate, due, modified, flagged');
    expect(row).toMatchObject({
      estimate: 9,
      due: '2999-06-01T09:30',
      modified: '2999-01-01',
      flagged: 'false',
    });
  });
});

describe('compileAtlasQuery: the statement', () => {
  const compile = (text: string) =>
    compileAtlasQuery(parseAtlasQuery(text), { types: QUERY_TEST_TYPES, resolveLink });

  it('binds every name and value from the query rather than writing it in', () => {
    const { sql, parameters } = compile(
      "FROM task WHERE notes = 'x''; DROP TABLE files; --' AND project.owner = [[Julie]] SORT BY estimate",
    );
    // A column is named after its field, from the vault's own type; the query's
    // own words reach the conditions and the order only as bound values.
    const [, afterSelect] = sql.split('\nFROM files AS n\n');
    expect(afterSelect).toBeDefined();
    expect(afterSelect).not.toContain('DROP');
    expect(afterSelect).not.toContain('Julie');
    expect(afterSelect).not.toContain('estimate');
    expect(afterSelect).not.toContain('owner');
    expect(parameters).toContain("x'; DROP TABLE files; --");
    expect(parameters).toContain('people/Julie.md');
    expect(run("FROM task WHERE notes = 'x''; DROP TABLE files; --'")).toEqual([]);
    expect(titles('FROM person')).toEqual(['Julie', 'Sam']);
  });

  it('is marked, so it can be told apart from SQL written by hand', () => {
    expect(compile('FROM task').sql.startsWith('/* atlas-query */ SELECT')).toBe(true);
  });

  it('says which fields the rows are grouped by, in order', () => {
    expect(
      compile('FROM task GROUP BY project THEN status').groups.map((field) => field.text),
    ).toEqual(['project', 'status']);
  });

  it('refuses a query the vault cannot answer', () => {
    expect(() => compile('FROM task WHERE nope = 1')).toThrow('A task has no field called nope.');
  });
});
