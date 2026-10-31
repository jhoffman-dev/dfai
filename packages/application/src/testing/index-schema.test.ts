import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INDEX_SCHEMA } from './index-schema.ts';
import { DatabaseSync } from './node-sqlite.ts';

/**
 * One source for the index's shape (#134). The host makes the index from
 * `index_schema.sql`, and the test indexes here make it from the same file.
 * Many SQLite tests still make only the few tables they read, inline; each of
 * those is held to the file here, so a column that changes type or goes away
 * in the app fails a test rather than leaving a test that reads a shape the
 * app no longer has.
 */

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

interface Column {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
}

function columnsOf(database: DatabaseSync, table: string): Column[] {
  return (database.prepare(`PRAGMA table_xinfo("${table}")`).all() as unknown as Column[]).map(
    ({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }),
  );
}

/** A CREATE statement as the shape it makes: no `IF NOT EXISTS`, case and spacing folded. */
const shapeOf = (sql: string) =>
  sql
    .replace(/\s+IF\s+NOT\s+EXISTS\s+/i, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),=])\s*/g, '$1')
    .trim()
    .toLowerCase();

const CREATE = /CREATE\s+(VIRTUAL\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/i;

/** The tables full-text search keeps beside a virtual one, which are SQLite's rather than ours. */
const isShadowOf = (name: string, virtual: readonly string[]) =>
  virtual.some((table) => new RegExp(`^${table}_(data|idx|content|docsize|config)$`).test(name));

function schemaOf(sql: string) {
  const database = new DatabaseSync(':memory:');
  database.exec(sql);
  const entries = database
    .prepare('SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL')
    .all() as { type: string; name: string; sql: string }[];
  const virtual = entries
    .filter((entry) => CREATE.exec(entry.sql)?.[1] !== undefined)
    .map((entry) => entry.name);
  const ours = entries.filter((entry) => !isShadowOf(entry.name, virtual));
  const tables = new Map(
    ours
      .filter((entry) => entry.type === 'table')
      .map((entry) => [entry.name, columnsOf(database, entry.name)]),
  );
  // An index, or a virtual table's options, is held to its whole statement.
  const statements = new Map(
    ours
      .filter((entry) => entry.type === 'index' || virtual.includes(entry.name))
      .map((entry) => [entry.name, shapeOf(entry.sql)]),
  );
  return { tables, statements };
}

const CANONICAL = schemaOf(INDEX_SCHEMA);

/** Every TypeScript file under the folders whose tests make index tables. */
function sources(folder: string): string[] {
  return readdirSync(new URL(folder, root), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => `${entry.parentPath}/${entry.name}`)
    .filter((path) => !path.includes('/node_modules/') && path !== fileURLToPath(import.meta.url));
}

/** The text from `start` to the parenthesis that closes the first one opened after it. */
function statementAt(text: string, start: number): string | null {
  let depth = 0;
  for (let at = start; at < text.length; at += 1) {
    if (text[at] === '(') depth += 1;
    else if (text[at] === ')' && --depth === 0) return text.slice(start, at + 1);
  }
  return null;
}

/** SQL written inside a JavaScript string, as the string holds it. */
const unescaped = (source: string) => source.replace(/\\n/g, '\n').replace(/\\(['"`\\])/g, '$1');

/** The CREATE TABLE and CREATE INDEX statements in a file that name the index's own tables and indexes. */
function inlineCopies(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(CREATE.source, 'gi'))) {
    const name = match[3]!;
    if (!CANONICAL.tables.has(name) && !CANONICAL.statements.has(name)) continue;
    const statement = statementAt(text, match.index);
    // A statement built from interpolations is the code's own; only literal copies can drift.
    if (statement !== null && !statement.includes('${')) found.push(unescaped(statement));
  }
  return found;
}

/** What the copies a file holds say that the index's own do not. */
const driftIn = (text: string) => inlineCopies(text).flatMap(driftOf);

/** A copy that is not SQL after all (a pattern that matches a statement, say): SQL a test runs fails that test. */
const UNREADABLE = ['unreadable'];

/** What a copy of a table or index says that the index's own does not. */
function driftOf(statement: string): string[] {
  const [, virtual, kind, name] = CREATE.exec(statement)!;
  if (kind!.toUpperCase() === 'INDEX' || virtual !== undefined) {
    const shape = shapeOf(statement);
    if (shape !== CANONICAL.statements.get(name!)) return [`${name}: ${shape}`];
    if (kind!.toUpperCase() === 'INDEX') return [];
  }
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(statement);
  } catch {
    return UNREADABLE;
  }
  const own = new Map(CANONICAL.tables.get(name!)!.map((column) => [column.name, column]));
  return columnsOf(database, name!).flatMap((column) => columnDrift(name!, column, own));
}

function columnDrift(table: string, column: Column, own: ReadonlyMap<string, Column>): string[] {
  const theirs = own.get(column.name);
  const at = `${table}.${column.name}`;
  if (theirs === undefined) return [`${at}: not in the index`];
  if (theirs.type !== column.type) return [`${at}: ${column.type}, not ${theirs.type}`];
  // Looser than the host's is only a fixture that takes less care; stricter would hide a null the host can hold.
  if (column.notnull > theirs.notnull) return [`${at}: NOT NULL, and the index's is not`];
  // No default is a fixture that always says, and one on a column the host makes every row
  // name is only a convenience; another default, or one where the host leaves null, is not.
  const named = theirs.notnull === 1 && theirs.dflt_value === null;
  if (column.dflt_value !== null && column.dflt_value !== theirs.dflt_value && !named) {
    return [`${at}: DEFAULT ${column.dflt_value}, not ${theirs.dflt_value}`];
  }
  return [];
}

describe('the index schema has one source', () => {
  it('is the file the host makes the index from, and the host holds no other copy', () => {
    const host = read('apps/desktop/src-tauri/src/index.rs');
    expect(host).toContain('include_str!("index_schema.sql")');
    expect(host).not.toMatch(/CREATE (TABLE|INDEX|VIRTUAL TABLE) IF NOT EXISTS/);
    expect(CANONICAL.tables.get('files')?.map((column) => column.name)).toContain('progress');
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
