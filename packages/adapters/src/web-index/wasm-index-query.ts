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
const MAX_QUERY_BYTES = 16 * 1024 * 1024;
const QUERY_TOO_LARGE = 'the result is larger than DFAI will read';
const NOT_A_READ = 'only a statement that reads the index can run here';

/** Pragmas that take an argument and only report: what describing a table needs. */
const DESCRIBING_PRAGMAS = new Set([
  'table_info',
  'table_xinfo',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
]);
/** The pragma that names the file behind each database, which says where things sit. */
const LOCATING_PRAGMA = 'database_list';

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
        return name === `pragma_${LOCATING_PRAGMA}` ? capi.SQLITE_DENY : capi.SQLITE_OK;
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
  const statement = prepareRead(sqlite3, database, sql);
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
  } finally {
    statement.finalize();
  }
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
