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
}

function columnsOf(database: DatabaseSync, table: string): Column[] {
  return (database.prepare(`PRAGMA table_xinfo("${table}")`).all() as unknown as Column[]).map(
    ({ name, type, notnull }) => ({ name, type, notnull }),
  );
}

/** A CREATE INDEX as the shape it makes: no `IF NOT EXISTS`, spacing folded. */
const indexShape = (sql: string) =>
  sql
    .replace(/\s+IF NOT EXISTS\s+/i, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim();

function schemaOf(sql: string) {
  const database = new DatabaseSync(':memory:');
  database.exec(sql);
  const entries = database
    .prepare('SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL')
    .all() as { type: string; name: string; sql: string }[];
  // Full-text search keeps its own tables beside each virtual one; they are SQLite's, not ours.
  const ours = entries.filter((entry) => !/_(data|idx|content|docsize|config)$/.test(entry.name));
  const tables = new Map(
    ours
      .filter((entry) => entry.type === 'table')
      .map((entry) => [entry.name, columnsOf(database, entry.name)]),
  );
  const indexes = new Map(
    ours
      .filter((entry) => entry.type === 'index')
      .map((entry) => [entry.name, indexShape(entry.sql)]),
  );
  return { tables, indexes };
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
  for (const match of text.matchAll(
    /CREATE (?:VIRTUAL )?(?:TABLE|INDEX) (?:IF NOT EXISTS )?"?(\w+)"?/g,
  )) {
    const name = match[1]!;
    if (!CANONICAL.tables.has(name) && !CANONICAL.indexes.has(name)) continue;
    const statement = statementAt(text, match.index);
    // A statement built from interpolations is the code's own; only literal copies can drift.
    if (statement !== null && !statement.includes('${')) found.push(unescaped(statement));
  }
  return found;
}

/** What a copy of a table or index says that the index's own does not. */
function driftOf(statement: string): string[] {
  const database = new DatabaseSync(':memory:');
  const made = /CREATE (?:VIRTUAL )?TABLE (?:IF NOT EXISTS )?"?(\w+)"?/.exec(statement);
  if (made === null) {
    const name = /CREATE INDEX (?:IF NOT EXISTS )?"?(\w+)"?/.exec(statement)![1]!;
    const shape = indexShape(statement);
    return shape === CANONICAL.indexes.get(name) ? [] : [`index ${name}: ${shape}`];
  }
  const table = made[1]!;
  try {
    database.exec(statement);
  } catch {
    // Not SQL after all (a pattern that matches a statement, say): SQL that a test runs fails that test.
    return [];
  }
  const own = new Map(CANONICAL.tables.get(table)!.map((column) => [column.name, column]));
  return columnsOf(database, table).flatMap((column) => {
    const theirs = own.get(column.name);
    if (theirs === undefined) return [`${table}.${column.name}: not in the index`];
    if (theirs.type !== column.type)
      return [`${table}.${column.name}: ${column.type}, not ${theirs.type}`];
    // Looser than the host's is only a fixture that takes less care; stricter would hide a null the host can hold.
    if (column.notnull > theirs.notnull)
      return [`${table}.${column.name}: NOT NULL, and the index's is not`];
    return [];
  });
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
    const drift = copies.flatMap(({ file, statement }) =>
      driftOf(statement).map((problem) => `${file}: ${problem}`),
    );
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
      'index links_dst: CREATE INDEX links_dst ON links(dst)',
    ]);
    expect(driftOf('CREATE INDEX IF NOT EXISTS links_dst ON links (dst, src)')).toEqual([]);
    expect(driftOf('CREATE TABLE relations (src TEXT NOT NULL, dst TEXT NOT NULL)')).toEqual([
      "relations.dst: NOT NULL, and the index's is not",
    ]);
    expect(driftOf('CREATE TABLE relations (src TEXT, dst TEXT)')).toEqual([]);
  });
});
