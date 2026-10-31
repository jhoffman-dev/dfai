/**
 * Attacks on PR #653 (#134): copies of the index's tables and indexes that
 * `index-schema.test.ts` does not see, or sees and passes, though they make a
 * shape the host does not. The guard exports nothing, so its own helpers are
 * loaded from its source here (types stripped), rather than copied.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { INDEX_SCHEMA } from './index-schema.ts';
import { DatabaseSync } from './node-sqlite.ts';

const GUARD = new URL('./index-schema.test.ts', import.meta.url);

interface Guard {
  inlineCopies: (text: string) => string[];
  driftIn: (text: string) => string[];
}

/** The guard's helpers, everything above its `describe`, run as they are written. */
function loadGuard(): Guard {
  const source = readFileSync(GUARD, 'utf8');
  const body = source.slice(source.indexOf('const root'), source.indexOf("describe('"));
  const { outputText } = ts.transpileModule(body.replaceAll('import.meta.url', '__url'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  const make = new Function(
    '__url',
    'readdirSync',
    'readFileSync',
    'fileURLToPath',
    'INDEX_SCHEMA',
    'DatabaseSync',
    `${outputText}\nreturn { inlineCopies, driftIn };`,
  ) as (...args: unknown[]) => Guard;
  return make(GUARD.href, readdirSync, readFileSync, fileURLToPath, INDEX_SCHEMA, DatabaseSync);
}

const guard = loadGuard();

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
  it.fails.each([
    ['a unique index', 'CREATE_UNIQUE INDEX links_dst ON links(dst)'],
    ['a temp table', 'CREATE_TEMP TABLE files (path TEXT PRIMARY KEY, progress REAL)'],
    ['a temporary table', 'CREATE_TEMPORARY TABLE files (path TEXT PRIMARY KEY, progress REAL)'],
    ['a bracket-quoted name', 'CREATE_TABLE [files] (path TEXT PRIMARY KEY, progress REAL)'],
    ['a backtick-quoted name', 'CREATE_TABLE `files` (path TEXT PRIMARY KEY, progress REAL)'],
    ['a schema-qualified name', 'CREATE_TABLE main.files (path TEXT PRIMARY KEY, progress REAL)'],
  ])('sees a copy of another shape written as %s', (_name, copy) => {
    expect(driftIn(copy)).toHaveLength(1);
  });

  it.fails('sees an index copy that differs only in its WHERE clause (a partial index)', () => {
    // statementAt stops at the first closing parenthesis, so the WHERE is cut off before the compare.
    expect(driftIn('CREATE_INDEX links_dst ON links(dst, src) WHERE dst IS NOT NULL')).toEqual([
      expect.stringContaining('links_dst'),
    ]);
  });

  it.fails('sees a copy that drops the host primary key', () => {
    // Without it, INSERT OR REPLACE keeps both rows and ON CONFLICT(path) is an error.
    expect(driftIn('CREATE_TABLE files (path TEXT, title TEXT NOT NULL)')).toHaveLength(1);
  });

  it.fails('sees a copy with a UNIQUE the host does not have', () => {
    expect(
      driftIn('CREATE_TABLE tags (path TEXT NOT NULL, tag TEXT NOT NULL UNIQUE)'),
    ).toHaveLength(1);
  });

  it.fails('sees an index on a host table that the host does not make (plans would differ)', () => {
    expect(driftIn('CREATE_INDEX props_value ON props(value_text)')).toHaveLength(1);
  });

  it.fails('still holds the literal columns of a copy that interpolates one default', () => {
    // One `${` anywhere skips the whole statement, so `progress REAL` passes unseen.
    const copy =
      'CREATE_TABLE files (path TEXT PRIMARY KEY, progress REAL, summary TEXT DEFAULT ${empty})';
    expect(driftIn(copy)).toEqual(['files.progress: REAL, not INTEGER']);
  });
});

describe('attack #653: drift in the repo today that the guard passes', () => {
  const root = new URL('../../../../', import.meta.url);

  it.fails('every inline copy of `files` keeps the host primary key on path', () => {
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

  // The guard only forbids `CREATE (TABLE|INDEX|VIRTUAL TABLE) IF NOT EXISTS`: one space, upper case.
  const hostCheck = /CREATE (TABLE|INDEX|VIRTUAL TABLE) IF NOT EXISTS/;

  it('holds index.rs to the pattern tried below', () => {
    expect(readFileSync(GUARD, 'utf8')).toContain(
      `expect(host).not.toMatch(/${hostCheck.source}/);`,
    );
  });

  it.fails.each([
    ['without IF NOT EXISTS', 'CREATE_TABLE files (path TEXT PRIMARY KEY)'],
    ['in lower case', 'create table if not exists files (path TEXT PRIMARY KEY)'],
    ['as an index without IF NOT EXISTS', 'CREATE_INDEX links_dst ON links(dst)'],
  ])('the host check sees a second copy in index.rs written %s', (_name, second) => {
    expect(sql(second)).toMatch(hostCheck);
  });
});
