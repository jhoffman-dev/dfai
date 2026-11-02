import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type {
  IndexedNote,
  IndexEntry,
  IndexOpening,
  IndexStats,
  QueryResult,
  SearchHit,
  SearchScope,
  ViewTypeSpec,
} from '@dfai/application';
import type { WebIndexShape } from './web-index-shape.ts';
import { putNotes, removeNotes } from './wasm-index-writes.ts';
import { backlinksOf, manifestOf, notesOfType, searchIndex, statsOf } from './wasm-index-reads.ts';
import { rebuildViews, resultCodeOf, runQuery } from './wasm-index-query.ts';

/**
 * Where each vault's index file lives: the origin's private file system in
 * the browser (OPFS), memory in a test. A thin store; the host decides
 * nothing about what is in the file.
 */
export interface IndexFiles {
  /** The vault's index, made empty when there is none. Throws when the file is not a database. */
  open(vault: string): Database;
  /** Lets the vault's file go, keeping what it holds. */
  close(vault: string, database: Database): void;
  /** Throws the vault's file away. */
  discard(vault: string): void;
}

/**
 * The browser's index host: what the Rust host's index commands do
 * (`index.rs`), over SQLite's WebAssembly build, in the index worker. It
 * holds one vault's index at a time, the one last opened, and runs SQL. It
 * decides nothing (ADR-0005). Every call is synchronous; the worker's channel
 * (`index-channel.ts`) is what makes them asynchronous.
 */
export interface WasmIndexHost {
  open(vault: string): IndexOpening;
  clear(): void;
  manifest(): IndexEntry[];
  /** `vault` is the vault the notes were read from, when the caller says: refused once another's is open. */
  put(vault: string | null, notes: readonly IndexedNote[]): void;
  remove(vault: string | null, paths: readonly string[]): void;
  search(query: string, limit: number, scope: SearchScope): SearchHit[];
  notesOfType(type: string): { path: string; title: string }[];
  backlinks(path: string): string[];
  rebuildViews(types: readonly ViewTypeSpec[]): void;
  query(sql: string, parameters: readonly (string | number | null)[]): QueryResult;
  stats(): IndexStats;
}

const NOT_OPEN = 'the index is not open';
const ANOTHER_VAULT = 'another vault was opened before this could be indexed';

export function createWasmIndexHost({
  sqlite3,
  files,
  shape,
}: {
  sqlite3: Sqlite3Static;
  files: IndexFiles;
  /** The tables to make, from the host's schema file (`WEB_INDEX` in the app). */
  shape: WebIndexShape;
}): WasmIndexHost {
  let held: { vault: string; database: Database } | null = null;
  const database = () => {
    if (held === null) throw new Error(NOT_OPEN);
    return held.database;
  };
  const meantFor = (vault: string | null) => {
    const open = database();
    if (vault !== null && vault !== held?.vault) throw new Error(ANOTHER_VAULT);
    return open;
  };
  const replace = (vault: string, discarding: boolean): IndexOpening => {
    // Let go before the file is touched: a database outliving its file answers from the gone one.
    if (held !== null) files.close(held.vault, held.database);
    held = null;
    if (discarding) files.discard(vault);
    const opened = openIndex({ files, vault, shape, notADatabase: sqlite3.capi.SQLITE_NOTADB });
    held = { vault, database: opened.database };
    return { fresh: opened.fresh };
  };
  return {
    open: (vault) => replace(vault, false),
    clear: () => {
      if (held === null) throw new Error(NOT_OPEN);
      replace(held.vault, true);
    },
    manifest: () => manifestOf(database()),
    put: (vault, notes) => putNotes(meantFor(vault), notes),
    remove: (vault, paths) => removeNotes(meantFor(vault), paths),
    search: (query, limit, scope) => searchIndex(database(), { query, limit, scope }),
    notesOfType: (type) => notesOfType(database(), type),
    backlinks: (path) => backlinksOf(database(), path),
    rebuildViews: (types) => rebuildViews(database(), types),
    query: (sql, parameters) => runQuery(sqlite3, database(), { sql, parameters }),
    stats: () => statsOf(database()),
  };
}

/**
 * Opens the vault's index, making it when there is none of this shape, and
 * says which. An old shape — or a file that is not a database at all — is
 * thrown away and made again: the index is derived, so it is rebuilt, never
 * migrated.
 */
function openIndex({
  files,
  vault,
  shape,
  notADatabase,
}: {
  files: IndexFiles;
  vault: string;
  shape: WebIndexShape;
  /** SQLite's SQLITE_NOTADB: the one failure that means the file is no index to keep. */
  notADatabase: number;
}): { database: Database; fresh: boolean } {
  let database = openOrDiscard(files, vault, notADatabase);
  const fresh = storedVersion(database) !== shape.version;
  if (fresh) {
    files.close(vault, database);
    files.discard(vault);
    database = files.open(vault);
  }
  database.exec(shape.schema);
  if (fresh) database.exec(`PRAGMA user_version = ${shape.version}`);
  return { database, fresh };
}

/**
 * The vault's index file, open. One that is not a database (cut short,
 * overwritten) is a cache to rebuild, as the host's `stored_version` reads
 * it; any other failure — busy, an I/O error — says nothing against the file,
 * which is kept, and the failure is passed on.
 */
function openOrDiscard(files: IndexFiles, vault: string, notADatabase: number): Database {
  let database: Database | null = null;
  try {
    database = files.open(vault);
    // Read now: a file that is not a database opens, and fails on the first read.
    storedVersion(database);
    return database;
  } catch (error) {
    if (database !== null) files.close(vault, database);
    if (resultCodeOf(error) !== notADatabase) throw error;
    files.discard(vault);
    return files.open(vault);
  }
}

const storedVersion = (database: Database) => Number(database.selectValue('PRAGMA user_version'));
