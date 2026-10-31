import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL,
  driftIn,
  driftOf,
  hostCopies,
  inlineCopies,
  UNREADABLE,
} from './index-schema-guard.ts';

/**
 * One source for the index's shape (#134). The host makes the index from
 * `index_schema.sql`, and the test indexes here make it from the same file.
 * Many SQLite tests still make only the few tables they read, inline; each of
 * those is held to the file here (what counts as drift is in
 * `index-schema-guard.ts`), so a column that changes type or goes away in the
 * app fails a test rather than leaving a test that reads a shape the app no
 * longer has.
 */

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

/** Every TypeScript file under the folders whose tests make index tables. */
function sources(folder: string): string[] {
  return readdirSync(new URL(folder, root), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => `${entry.parentPath}/${entry.name}`)
    .filter(
      (path) => !path.includes('/node_modules/') && !/\/testing\/index-schema[^/]*\.ts$/.test(path),
    );
}

describe('the index schema has one source', () => {
  it('is the file the host makes the index from, and the host holds no other copy', () => {
    const host = read('apps/desktop/src-tauri/src/index.rs');
    expect(host).toContain('include_str!("index_schema.sql")');
    expect(hostCopies(host)).toEqual([]);
    expect(CANONICAL.tables.get('files')?.columns.map((column) => column.name)).toContain(
      'progress',
    );
  });

  it('holds every inline copy in the tests to it: no column of another type, and no index of another shape', () => {
    const copies = ['packages', 'apps/desktop/src', 'apps/mcp/src', 'e2e'].flatMap((folder) =>
      sources(folder).flatMap((path) =>
        inlineCopies(readFileSync(path, 'utf8')).map((statement) => ({
          file: path.slice(root.pathname.length),
          statement,
        })),
      ),
    );
    // Found at all: a scan that matched nothing would pass however far the copies drift.
    expect(copies.map(({ file }) => file)).toContain(
      'packages/domain/src/graph/graph-query.sqlite.test.ts',
    );
    const found = copies.map(({ file, statement }) => ({ file, drift: driftOf(statement) }));
    // The one copy that is not SQL, named, so a new skip shows here rather than passing unseen.
    expect(found.filter(({ drift }) => drift === UNREADABLE).map(({ file }) => file)).toEqual([
      'packages/domain/src/query-language/type-index.plan.sqlite.test.ts',
    ]);
    const drift = found
      .filter(({ drift }) => drift !== UNREADABLE)
      .flatMap(({ file, drift }) => drift.map((problem) => `${file}: ${problem}`));
    expect(drift).toEqual([]);
  });

  it('would see a copy drift', () => {
    expect(driftOf('CREATE TABLE files (path TEXT PRIMARY KEY, progress REAL)')).toEqual([
      'files.progress: REAL, not INTEGER',
    ]);
    expect(driftOf('CREATE TABLE links (src TEXT NOT NULL, gone TEXT)')).toEqual([
      'links.gone: not in the index',
    ]);
    expect(driftOf('CREATE INDEX links_dst ON links(dst)')).toEqual([
      'links_dst: create index links_dst on links(dst)',
    ]);
    expect(driftOf('CREATE INDEX IF NOT EXISTS links_dst ON links (dst, src)')).toEqual([]);
    expect(driftOf('CREATE TABLE relations (src TEXT NOT NULL, dst TEXT NOT NULL)')).toEqual([
      "relations.dst: NOT NULL, and the index's is not",
    ]);
    expect(driftOf('CREATE TABLE relations (src TEXT, dst TEXT)')).toEqual([]);
  });

  it.each([
    ['an index the host also has', 'CREATE INDEX highlights_path_idx ON highlights(idx)'],
    ['in lower case', 'create table files (path TEXT PRIMARY KEY, progress REAL)'],
    ['with doubled spaces', 'CREATE  TABLE files (path TEXT PRIMARY KEY, progress REAL)'],
    ['across lines', 'CREATE TABLE\n  files (path TEXT PRIMARY KEY, progress REAL)'],
    [
      'a search table of other options',
      "CREATE VIRTUAL TABLE fts USING fts5(path, title, body, tokenize = 'porter')",
    ],
    ['a default where the host leaves null', "CREATE TABLE files (note_type TEXT DEFAULT 'task')"],
    [
      'a column of another default',
      "CREATE TABLE files (path TEXT PRIMARY KEY, summary TEXT NOT NULL DEFAULT 'none')",
    ],
  ])('would see a copy drift written %s', (_name, copy) => {
    expect(driftIn(copy)).toHaveLength(1);
  });

  it.each([
    [
      'a search table spaced and cased otherwise',
      "create virtual table fts using fts5(path,title,body,tokenize='unicode61 remove_diacritics 2')",
    ],
    ['a column with no default where the host has one', 'CREATE TABLE files (summary TEXT)'],
    [
      'a default on a column every host row names',
      'CREATE TABLE files (path TEXT PRIMARY KEY, size INTEGER NOT NULL DEFAULT 0)',
    ],
  ])('lets a copy be %s', (_name, copy) => {
    expect(inlineCopies(copy)).toHaveLength(1);
    expect(driftIn(copy)).toEqual([]);
  });
});
