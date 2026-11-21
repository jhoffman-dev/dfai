import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { compileTypeCountsQuery } from '../sidebar/type-counts-query.ts';
import { PROPS_TYPE_FOLD_INDEX } from '../types/note-type-sql.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';
import { QUERY_TEST_TYPES } from './query-fixtures.ts';
import { compileViewQuery } from '../query/view-query.ts';
import { typeViewSelectSql } from './type-view.ts';

/**
 * Plan guards (PR #616's review): finding notes by type in any case must not
 * cost more than finding them by the type as written did. The index's
 * `props_type_fold` serves every such read, a query's FROM picks its notes
 * through it, and a type's view stays one pass over the notes (a pivot), not
 * a subquery per cell. Each guard reads the plan SQLite chose, as the
 * correlated-reads tests do (#385), so a slower shape fails here rather than
 * in a vault.
 */
const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

/** The index's tables and indexes, as the host makes them (`index_schema.sql`). */
const SCHEMA = `
  CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                      modified INTEGER, size INTEGER NOT NULL, progress INTEGER);
  CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                      value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
  CREATE INDEX props_path ON props(path, key, value_text);
  CREATE INDEX props_key ON props(key, value_text);
  ${PROPS_TYPE_FOLD_INDEX};`;

function planOf(sql: string, parameters: readonly unknown[] = []): string[] {
  const database = new DatabaseSync(':memory:');
  database.exec(SCHEMA);
  return (
    database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(parameters as never[])) as {
      detail: string;
    }[]
  ).map((step) => step.detail);
}

describe('one source for the fold index', () => {
  it('the host makes the index the domain names, as the e2e host does', () => {
    expect(read('apps/desktop/src-tauri/src/index_schema.sql')).toContain(PROPS_TYPE_FOLD_INDEX);
    // Made where the host makes the props table, not merely imported.
    expect(read('e2e/host.ts')).toMatch(
      /CREATE TABLE props \([^`]*?\);[^`]*?\$\{PROPS_TYPE_FOLD_INDEX\};`\);/,
    );
  });
});

describe('notes found by type, in any case, are sought by the fold index', () => {
  it("a query's FROM picks its notes through props_type_fold", () => {
    const compiled = compileAtlasQuery(parseAtlasQuery('FROM task WHERE status = doing'), {
      types: QUERY_TEST_TYPES,
      resolveLink: () => null,
    });
    const plan = planOf(compiled.sql, compiled.parameters);
    expect(plan.some((step) => /props_type_fold \(key=\? AND <expr>=\?\)/.test(step))).toBe(true);
    // The type's notes are found first, then sought by path: no walk of every file.
    expect(plan.some((step) => /^SCAN n\b/.test(step))).toBe(false);
  });

  it('the sidebar counts seek each type through props_type_fold', () => {
    const { sql, parameters } = compileTypeCountsQuery(['task', 'project']);
    const plan = planOf(sql, parameters);
    expect(plan.some((step) => /props_type_fold \(key=\? AND <expr>=\?/.test(step))).toBe(true);
    expect(plan.some((step) => /^SCAN typed\b/.test(step))).toBe(false);
  });
});

describe("a type's view reads each cell by its note and key (#919)", () => {
  const TASK_VIEW = {
    name: 'task',
    columns: [
      { key: 'status', kind: 'select', many: false },
      { key: 'due', kind: 'date', many: false },
      { key: 'estimate', kind: 'number', many: false },
      { key: 'labels', kind: 'multiSelect', many: false },
      { key: 'project', kind: 'relation', many: false },
    ],
    progress: true,
  };

  /** The plan of `sql` over an index holding the task view. */
  function planOverView(sql: string, parameters: readonly unknown[]): string[] {
    const database = new DatabaseSync(':memory:');
    database.exec(SCHEMA);
    database.exec(`CREATE VIEW "v_task" AS\n${typeViewSelectSql(TASK_VIEW) ?? ''}`);
    return (
      database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(parameters as never[])) as {
        detail: string;
      }[]
    ).map((step) => step.detail);
  }

  it('seeks each cell through props_path by path and key, never a walk of every row', () => {
    const plan = planOf(typeViewSelectSql(TASK_VIEW) ?? '');
    const cells = plan.filter((step) =>
      /^SEARCH p USING INDEX props_path \(path=\? AND key=\?\)/.test(step),
    );
    // title and the five columns; progress is the file's own.
    expect(cells).toHaveLength(6);
    expect(plan.some((step) => /^SCAN (p|props)\b|props_key/.test(step))).toBe(false);
    expect(plan.some((step) => /props_type_fold \(key=\? AND <expr>=\?/.test(step))).toBe(true);
  });

  it('flattens into the page that reads it, so a page reads every column only of its own notes', () => {
    const { sql, parameters } = compileViewQuery({
      type: 'task',
      columns: ['status', 'due', 'estimate', 'labels', 'project'],
      filters: [],
      sorts: [{ key: 'due', direction: 'desc' }],
      limit: 500,
    });
    const plan = planOverView(sql, parameters);
    // A grouped view would be a co-routine run to its end before the page's ORDER BY.
    expect(plan.some((step) => step.startsWith('CO-ROUTINE'))).toBe(false);
    // The page's notes are chosen first, and the rows read are sought by path among them.
    expect(plan.some((step) => /^LIST SUBQUERY/.test(step))).toBe(true);
    expect(plan.some((step) => /^SCAN n\b/.test(step))).toBe(false);
  });
});
