import type { Database, PreparedStatement, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { QueryResult, ViewTypeSpec } from '@dfai/application';
import { cellOf } from './wasm-index-reads.ts';

/**
 * Running a query someone wrote, and remaking the type views, as the host
 * does (`run_query`, `rebuild_views` in `index.rs`): a query only ever reads,
 * and is cut at the host's limits, so a query answers alike on either.
 */

/** The host's MAX_QUERY_ROWS: a result past it is cut short and says so. */
export const MAX_QUERY_ROWS = 5_000;
/** The host's MAX_QUERY_BYTES: the most text a result may carry before it is refused. */
export const MAX_QUERY_BYTES = 16 * 1024 * 1024;
/**
 * The host's QUERY_STEP_BUDGET: how many steps of SQLite's virtual machine a
 * query may take before it is stopped. A budget rather than a clock, so a
 * runaway query stops alike on every machine, and the worker is free again.
 */
export const QUERY_STEP_BUDGET = 5_000_000;
/** What a query stopped at the budget is refused with: the host's word for it. */
const INTERRUPTED = 'interrupted';
const QUERY_TOO_LARGE = 'the result is larger than DFAI will read';
const NOT_A_READ = 'only a statement that reads the index can run here';

/** Pragmas that take an argument and only report: what describing a table needs. */
export const DESCRIBING_PRAGMAS: ReadonlySet<string> = new Set([
  'table_info',
  'table_xinfo',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
]);
/** The pragma that names the file behind each database, which says where things sit. */
export const LOCATING_PRAGMA = 'database_list';

/**
 * Tables the WebAssembly build has and the desktop's does not, which read
 * SQLite's own insides rather than the index: `sqlite_dbpage` hands out raw
 * pages, free ones holding a deleted note's text among them; `dbstat` the
 * pages' make-up; `bytecode`, `tables_used` and `sqlite_stmt` the statements.
 * The build's other modules (fts5, fts5vocab, rtree) need a table made first,
 * which a read-only statement cannot do.
 */
const INTERNAL_TABLES: ReadonlySet<string> = new Set([
  'sqlite_dbpage',
  'dbstat',
  'bytecode',
  'tables_used',
  'sqlite_stmt',
]);

/**
 * What SQLite may do while preparing someone's query: the host's `reads_only`.
 * No attaching another file, no transaction or savepoint left open, no pragma
 * that sets something, nothing that names the database's file.
 */
function readsOnly(capi: Sqlite3Static['capi']) {
  return (_: unknown, action: number, first: string | 0, second: string | 0): number => {
    const name = typeof first === 'string' ? first.toLowerCase() : '';
    switch (action) {
      case capi.SQLITE_ATTACH:
      case capi.SQLITE_DETACH:
      case capi.SQLITE_TRANSACTION:
      case capi.SQLITE_SAVEPOINT:
        return capi.SQLITE_DENY;
      case capi.SQLITE_PRAGMA:
        if (name === LOCATING_PRAGMA) return capi.SQLITE_DENY;
        return second !== 0 && !DESCRIBING_PRAGMAS.has(name) ? capi.SQLITE_DENY : capi.SQLITE_OK;
      case capi.SQLITE_READ:
        return name === `pragma_${LOCATING_PRAGMA}` || INTERNAL_TABLES.has(name)
          ? capi.SQLITE_DENY
          : capi.SQLITE_OK;
      default:
        return capi.SQLITE_OK;
    }
  };
}

/**
 * Prepares one statement that only reads, or refuses it. The authorizer is
 * held only while preparing, so the index's own writes are not bound by it.
 */
function prepareRead(sqlite3: Sqlite3Static, database: Database, sql: string): PreparedStatement {
  const { capi } = sqlite3;
  capi.sqlite3_set_authorizer(database, readsOnly(capi), 0);
  let statement: PreparedStatement;
  try {
    statement = database.prepare(sql);
  } finally {
    capi.sqlite3_set_authorizer(database, 0 as never, 0);
  }
  const readOnly = capi.sqlite3_stmt_readonly(statement) !== 0;
  // One statement only, as the host's prepare holds it: what follows the first is a second.
  const tail = sql.slice((capi.sqlite3_sql(statement) ?? '').length);
  if (!readOnly || !isBlank(tail)) {
    statement.finalize();
    throw new Error(NOT_A_READ);
  }
  return statement;
}

/** Space and comments alone: nothing that would run. */
const isBlank = (text: string) =>
  text
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, '')
    .trim() === '';

/** Runs a query that only reads, its rows cut at the host's limits. */
export function runQuery(
  sqlite3: Sqlite3Static,
  database: Database,
  { sql, parameters }: { sql: string; parameters: readonly (string | number | null)[] },
): QueryResult {
  const { capi } = sqlite3;
  const statement = prepareRead(sqlite3, database, sql);
  // Returning non-zero stops the statement: so one past the budget is interrupted.
  capi.sqlite3_progress_handler(database, QUERY_STEP_BUDGET, () => 1, 0);
  try {
    if (parameters.length > 0) statement.bind([...parameters]);
    const columns = statement.getColumnNames();
    const rows: (string | number | null)[][] = [];
    let bytes = 0;
    let truncated = false;
    while (statement.step()) {
      if (rows.length >= MAX_QUERY_ROWS) {
        truncated = true;
        break;
      }
      const row = columns.map((_, at) => cellOf(statement.get(at)));
      for (const cell of row) if (typeof cell === 'string') bytes += utf8Length(cell);
      if (bytes > MAX_QUERY_BYTES) throw new Error(QUERY_TOO_LARGE);
      rows.push(row);
    }
    return { columns, rows, truncated };
  } catch (error) {
    if (resultCodeOf(error) === capi.SQLITE_INTERRUPT)
      throw new Error(INTERRUPTED, { cause: error });
    throw error;
  } finally {
    capi.sqlite3_progress_handler(database, 0, 0, 0);
    statement.finalize();
  }
}

/** SQLite's result code on an error the WebAssembly build threw; null on any other. */
export function resultCodeOf(error: unknown): number | null {
  const code = (error as { resultCode?: unknown } | null)?.resultCode;
  return typeof code === 'number' ? code : null;
}

const encoder = new TextEncoder();
const utf8Length = (text: string) => encoder.encode(text).length;

/**
 * Makes one view per type from the `SELECT` TypeScript sends for it, dropped
 * and made again in one transaction. Two types spelt alike in another case
 * get none (SQLite names views in any case); a name that is no identifier, or
 * text that is no SELECT, is not written into a statement.
 */
export function rebuildViews(database: Database, types: readonly ViewTypeSpec[]): void {
  database.transaction(() => {
    const existing = database
      .selectArrays(
        "SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'v\\_%' ESCAPE '\\'",
      )
      .map(([name]) => String(name));
    for (const name of existing) database.exec(`DROP VIEW IF EXISTS "${name}"`);
    const spellings = new Map<string, number>();
    for (const { name } of types) {
      const folded = name.toLowerCase();
      spellings.set(folded, (spellings.get(folded) ?? 0) + 1);
    }
    for (const spec of types) {
      if ((spellings.get(spec.name.toLowerCase()) ?? 0) > 1) continue;
      if (!IDENTIFIER.test(spec.name) || !spec.select.startsWith('SELECT ')) continue;
      createView(database, spec);
    }
  });
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function createView(database: Database, spec: ViewTypeSpec): void {
  try {
    // One statement, as the host's `execute` runs one: a second hidden in the text never runs.
    database.prepare(`CREATE VIEW "v_${spec.name}" AS\n${spec.select}`).stepFinalize();
  } catch (error) {
    throw new Error(`cannot build the view for ${spec.name}: ${String(error)}`, { cause: error });
  }
}
