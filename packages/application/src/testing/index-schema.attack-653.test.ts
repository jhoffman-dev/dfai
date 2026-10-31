/**
 * Attacks on PR #653 (#134): copies of the index's tables and indexes that
 * `index-schema.test.ts` does not see, or sees and passes, though they make a
 * shape the host does not, tried against the guard's own helpers
 * (`index-schema-guard.ts`).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as guard from './index-schema-guard.ts';
import { DatabaseSync } from './node-sqlite.ts';

/**
 * Copies here are written `CREATE_TABLE` and made SQL only when tried, so the
 * guard's own scan of this file does not count them as the repo's copies.
 */
const sql = (text: string) => text.replaceAll('CREATE_', 'CREATE ');
const driftIn = (text: string) => guard.driftIn(sql(text));

describe('the guard is loaded as written', () => {
  it('sees the drift its own test says it sees', () => {
    expect(driftIn('CREATE_TABLE files (path TEXT PRIMARY KEY, progress REAL)')).toEqual([
      'files.progress: REAL, not INTEGER',
    ]);
  });
});

describe('attack #653: copies the index schema guard does not see', () => {
  it.each([
    ['a unique index', 'CREATE_UNIQUE INDEX links_dst ON links(dst)'],
    ['a temp table', 'CREATE_TEMP TABLE files (path TEXT PRIMARY KEY, progress REAL)'],
    ['a temporary table', 'CREATE_TEMPORARY TABLE files (path TEXT PRIMARY KEY, progress REAL)'],
    ['a bracket-quoted name', 'CREATE_TABLE [files] (path TEXT PRIMARY KEY, progress REAL)'],
    ['a backtick-quoted name', 'CREATE_TABLE `files` (path TEXT PRIMARY KEY, progress REAL)'],
    ['a schema-qualified name', 'CREATE_TABLE main.files (path TEXT PRIMARY KEY, progress REAL)'],
  ])('sees a copy of another shape written as %s', (_name, copy) => {
    expect(driftIn(copy)).toHaveLength(1);
  });

  it('sees an index copy that differs only in its WHERE clause (a partial index)', () => {
    // statementAt stops at the first closing parenthesis, so the WHERE is cut off before the compare.
    expect(driftIn('CREATE_INDEX links_dst ON links(dst, src) WHERE dst IS NOT NULL')).toEqual([
      expect.stringContaining('links_dst'),
    ]);
  });

  it('sees a copy that drops the host primary key', () => {
    // Without it, INSERT OR REPLACE keeps both rows and ON CONFLICT(path) is an error.
    expect(driftIn('CREATE_TABLE files (path TEXT, title TEXT NOT NULL)')).toHaveLength(1);
  });

  it('sees a copy with a UNIQUE the host does not have', () => {
    expect(
      driftIn('CREATE_TABLE tags (path TEXT NOT NULL, tag TEXT NOT NULL UNIQUE)'),
    ).toHaveLength(1);
  });

  it('sees an index on a host table that the host does not make (plans would differ)', () => {
    expect(driftIn('CREATE_INDEX props_value ON props(value_text)')).toHaveLength(1);
  });

  it('still holds the literal columns of a copy that interpolates one default', () => {
    // One `${` anywhere skips the whole statement, so `progress REAL` passes unseen.
    const copy =
      'CREATE_TABLE files (path TEXT PRIMARY KEY, progress REAL, summary TEXT DEFAULT ${empty})';
    expect(driftIn(copy)).toEqual(['files.progress: REAL, not INTEGER']);
  });
});

describe('attack #653: drift in the repo today that the guard passes', () => {
  const root = new URL('../../../../', import.meta.url);

  it('every inline copy of `files` keeps the host primary key on path', () => {
    // packages/domain/src/query/sql-query.test.ts:64 makes `files (path TEXT, title TEXT)`.
    const text = readFileSync(new URL('packages/domain/src/query/sql-query.test.ts', root), 'utf8');
    const [copy] = guard
      .inlineCopies(text)
      .filter((statement) => /TABLE\s+files\b/i.test(statement));
    const database = new DatabaseSync(':memory:');
    database.exec(copy!);
    const path = (
      database.prepare('PRAGMA table_info(files)').all() as { name: string; pk: number }[]
    ).find((column) => column.name === 'path');
    expect(path?.pk).toBe(1);
  });

  it.each([
    ['without IF NOT EXISTS', 'CREATE_TABLE files (path TEXT PRIMARY KEY)'],
    ['in lower case', 'create table if not exists files (path TEXT PRIMARY KEY)'],
    ['as an index without IF NOT EXISTS', 'CREATE_INDEX links_dst ON links(dst)'],
  ])('the host check sees a second copy in index.rs written %s', (_name, second) => {
    expect(guard.hostCopies(`fn create() { run("${sql(second)}") }`)).toHaveLength(1);
  });

  it("the host check leaves the test modules' tables alone", () => {
    const source = sql(
      'fn open() {}\n#[cfg(test)]\nmod tests {\n  fn old() { run("CREATE_TABLE files (path TEXT)"); }\n}\n',
    );
    expect(guard.hostCopies(source)).toEqual([]);
  });
});
