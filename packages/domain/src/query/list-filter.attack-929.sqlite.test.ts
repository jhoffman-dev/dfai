import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { typeViewColumns, typeViewSelectSql } from '../query-language/type-view.ts';
import { parseObjectType, type ObjectType } from '../types/property-def.ts';
import {
  compileViewQuery,
  type QueryFilter,
  type QueryReach,
  type ViewQuery,
} from './view-query.ts';

/**
 * Attack on PR #929 (#923): a filter on a list of text answered from its items
 * must keep exactly the rows the cell's filter kept.
 */

const root = new URL('../../../../', import.meta.url);
const SCHEMA = readFileSync(new URL('apps/desktop/src-tauri/src/index_schema.sql', root), 'utf8');

const meetingOf = (attendees: object | string) =>
  parseObjectType({ name: 'meeting', properties: { attendees } });
const LISTED = meetingOf({ kind: 'text', many: true });
const SINGLE = meetingOf('text');

function vaultOf(view: ObjectType, notes: Record<string, Record<string, unknown>>) {
  const database = new DatabaseSync(':memory:');
  database.exec(SCHEMA);
  const file = database.prepare(
    'INSERT INTO files (path, title, summary, modified, size) VALUES (?, ?, ?, ?, 0)',
  );
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text, value_num, value_date, value_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const [path, frontmatter] of Object.entries(notes)) {
    file.run(path, path, '', 1);
    for (const row of indexablePropertiesOf({ type: 'meeting', ...frontmatter }))
      prop.run(path, row.key, row.index, row.text, row.number, row.date, row.json);
  }
  const select = typeViewSelectSql({
    name: 'meeting',
    columns: typeViewColumns(view),
    progress: false,
  });
  database.exec(`CREATE VIEW v_meeting AS\n${select ?? ''}`);
  return database;
}

const tableOf = (filter: QueryFilter): ViewQuery => ({
  type: 'meeting',
  columns: ['attendees'],
  filters: [filter],
  sorts: [{ key: 'path', direction: 'asc' }],
  limit: 500,
});

function pathsOf(database: DatabaseSync, query: ViewQuery, reach: QueryReach): unknown[] {
  const { sql, parameters } = compileViewQuery(query, {}, reach);
  return database
    .prepare(sql)
    .all(...parameters)
    .map((row) => row['path']);
}

describe('attack 929: a list filter from the items keeps the rows the cell kept', () => {
  // The one deliberate difference from main (list-filter.ts): YAML's "\0"
  // escape writes U+0000 into an item, and LIKE reads a text only up to it, so
  // the joined cell hid every item after one holding a NUL. Item by item, each
  // is read up to its own NUL, and the later item is found.
  it('contains finds an item that follows one holding a NUL character, as the cell did not', () => {
    const database = vaultOf(LISTED, {
      'a.md': { attendees: ['x\u0000y', 'mara@example.com'] },
      'b.md': { attendees: ['mara@example.com'] },
    });
    const query = tableOf({ key: 'attendees', operator: 'contains', value: 'mara' });
    expect(pathsOf(database, query, {})).toEqual(['b.md']);
    expect(pathsOf(database, query, { viewColumns: typeViewColumns(LISTED) })).toEqual([
      'a.md',
      'b.md',
    ]);
  });

  it('a filter keeps no note whose shown cell the filter rejects when the view predates a list', () => {
    // The type became a list but the index's view is still the single-valued one
    // (rebuildViews is asynchronous and a failed rebuild keeps the old views).
    const database = vaultOf(SINGLE, {
      'a.md': { attendees: ['mara@example.com', 'tobias@example.com'] },
      'b.md': { attendees: 'mara@example.com' },
    });
    const query = tableOf({ key: 'attendees', operator: 'contains', value: 'mara' });
    const cell = pathsOf(database, query, {});
    expect(cell).toEqual(['b.md']);
    expect(pathsOf(database, query, { viewColumns: typeViewColumns(LISTED) })).toEqual(cell);
  });
});
