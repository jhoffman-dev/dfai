import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { compileViewQuery, type ViewQuery } from '../query/view-query.ts';
import { compileParaCandidatesQuery } from './para-migration.ts';
import { compileParaValuesQuery, outsideParaArchiveSql, paraProjectSql } from './para-value.ts';

type Notes = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** #213's SQL run for real against SQLite: the index's `props`, and a stand-in for `v_project`. */
function indexOf(notes: Notes) {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
    value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE files (path TEXT PRIMARY KEY);`);
  for (const [path, frontmatter] of Object.entries(notes)) {
    database.prepare('INSERT INTO files VALUES (?)').run(path);
    for (const row of indexablePropertiesOf(frontmatter)) {
      database
        .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
  }
  database.exec(`CREATE VIEW v_project AS
    SELECT files.path AS "path", files.path AS "title", '' AS "summary",
      (SELECT value_text FROM props WHERE props.path = files.path AND key = 'para') AS "para"
    FROM files WHERE files.path IN (SELECT path FROM props WHERE key = 'type' AND value_text = 'project')`);
  return database;
}

const paths = (rows: readonly Record<string, unknown>[]) => rows.map((row) => row['path']).sort();

const NOTES: Notes = {
  'DFAI.md': { type: 'project' },
  'Home.md': { type: 'project', para: 'area' },
  'Manual.md': { type: 'project', para: 'resource' },
  'Old.md': { type: 'project', para: 'archive' },
  'Shouting.md': { type: 'Project', para: ' ARCHIVE ' },
  'Someday.md': { type: 'project', para: 'someday' },
  'Kept.md': { type: 'task', para: 'archive' },
};

describe('outsideParaArchiveSql', () => {
  it('leaves out exactly the Project notes set to archive, in any spelling', () => {
    const database = indexOf(NOTES);
    const rows = database
      .prepare(`SELECT path FROM files WHERE ${outsideParaArchiveSql('files.path')}`)
      .all();
    expect(paths(rows)).toEqual(['DFAI.md', 'Home.md', 'Kept.md', 'Manual.md', 'Someday.md']);
  });
});

describe('paraProjectSql', () => {
  it('keeps the Project notes that are projects: no PARA, project, or one it cannot read', () => {
    const database = indexOf(NOTES);
    const rows = database
      .prepare(
        `SELECT path FROM files WHERE path IN (SELECT path FROM props WHERE key = 'type' AND lower(value_text) = 'project') AND ${paraProjectSql('files.path')}`,
      )
      .all();
    expect(paths(rows)).toEqual(['DFAI.md', 'Someday.md']);
  });
});

describe('compileParaValuesQuery', () => {
  // `type: Project` is a project here too, as FROM project finds it (follow-up to #110).
  it('lists each note of the type holding a PARA, in any case, and what it says', () => {
    const { sql, parameters } = compileParaValuesQuery('project');
    const rows = indexOf(NOTES)
      .prepare(sql)
      .all(...parameters);
    expect(rows.map((row) => [row['path'], row['para']])).toEqual([
      ['Home.md', 'area'],
      ['Manual.md', 'resource'],
      ['Old.md', 'archive'],
      ['Shouting.md', 'ARCHIVE'],
      ['Someday.md', 'someday'],
    ]);
  });
});

describe('a view over projects (#213)', () => {
  const projects: ViewQuery = {
    type: 'project',
    columns: ['para'],
    filters: [],
    sorts: [],
    limit: 100,
  };

  it('leaves out the projects archived by their PARA, and keeps them when archived ones are asked for', () => {
    const database = indexOf(NOTES);
    const run = (includeArchived: boolean) => {
      const { sql, parameters } = compileViewQuery(projects, {}, { includeArchived });
      return paths(database.prepare(sql).all(...parameters));
    };
    expect(run(false)).toEqual(['DFAI.md', 'Home.md', 'Manual.md', 'Someday.md']);
    expect(run(true)).toEqual(['DFAI.md', 'Home.md', 'Manual.md', 'Old.md', 'Someday.md']);
  });

  it('counts the same way a dashboard does', () => {
    const { sql, parameters } = compileViewQuery(projects, {
      aggregate: { kind: 'count', column: null },
    });
    expect(
      indexOf(NOTES)
        .prepare(sql)
        .all(...parameters),
    ).toEqual([{ value: 4 }]);
  });
});

describe('compileParaCandidatesQuery', () => {
  it('finds every Area, Resource and Project note in any spelling, and nothing else', () => {
    const { sql, parameters } = compileParaCandidatesQuery();
    const rows = indexOf({
      ...NOTES,
      'Garden.md': { type: 'Area' },
      'Manual.md': { type: ' resource ' },
      'Plain.md': {},
    })
      .prepare(sql)
      .all(...parameters);
    expect(rows.map((row) => row['path'])).toEqual([
      'DFAI.md',
      'Garden.md',
      'Home.md',
      'Manual.md',
      'Old.md',
      'Shouting.md',
      'Someday.md',
    ]);
  });
});
