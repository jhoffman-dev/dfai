import type { Database, SqlValue } from '@sqlite.org/sqlite-wasm';
import type { IndexEntry, IndexStats, SearchHit, SearchScope } from '@dfai/application';

/**
 * The browser index's own reads, as the host runs them (`index.rs`): the
 * same statements, so search, backlinks and a type's notes answer alike on
 * either. The prefix a search skips is handed in and obeyed (ADR-0014).
 */

/**
 * How much a word found in each column of `fts` counts — path, title, body
 * — when hits are ranked: the host's SEARCH_WEIGHTS (#211).
 */
export const SEARCH_WEIGHTS = 'bm25(fts, 5.0, 10.0, 1.0)';

const NOTE_SEARCH = `SELECT files.path, fts.title, snippet(fts, 2, '<<', '>>', '…', 12)
  FROM fts JOIN files ON files.rowid = fts.rowid
  WHERE fts MATCH ?1
    AND (?3 IS NULL OR lower(substr(files.path, 1, length(?3))) <> ?3)
  ORDER BY ${SEARCH_WEIGHTS} LIMIT ?2`;

const HIGHLIGHT_SEARCH = `SELECT highlights.path, files.title, highlights.id,
         snippet(highlights_fts, -1, '<<', '>>', '…', 12)
  FROM highlights_fts
  JOIN highlights ON highlights.rowid = highlights_fts.rowid
  JOIN files ON files.path = highlights.path
  WHERE highlights_fts MATCH ?1
    AND (?3 IS NULL OR lower(substr(files.path, 1, length(?3))) <> ?3)
  ORDER BY bm25(highlights_fts), highlights.path, highlights.idx LIMIT ?2`;

/** What the index holds of each note: its version (from `manifest`), size, digest and type. */
export function manifestOf(database: Database): IndexEntry[] {
  return database
    .selectArrays(
      `SELECT files.path, manifest.version, files.size, files.digest, files.note_type
       FROM files JOIN manifest ON manifest.path = files.path`,
    )
    .map(([path, version, size, digest, type]) => ({
      path: String(path),
      modified: Number(version),
      size: Number(size),
      digest: String(digest),
      type: type === null ? null : String(type),
    }));
}

/** The notes that match, then — when the scope asks — the highlights (#507). */
export function searchIndex(
  database: Database,
  { query, limit, scope }: { query: string; limit: number; scope: SearchScope },
): SearchHit[] {
  const bind = [query, limit, scope.skipPrefix ?? null];
  try {
    const notes = database.selectArrays(NOTE_SEARCH, bind).map(([path, title, snippet]) => ({
      path: String(path),
      title: String(title),
      snippet: String(snippet),
    }));
    if (scope.highlights !== true) return notes;
    const highlights = database
      .selectArrays(HIGHLIGHT_SEARCH, bind)
      .map(([path, title, block, snippet]) => ({
        path: String(path),
        title: String(title),
        snippet: String(snippet),
        block: String(block),
      }));
    return [...notes, ...highlights];
  } catch (error) {
    // A malformed search expression is a person typing, not a failure: said as the host says it.
    throw new Error(`bad search: ${messageOf(error)}`, { cause: error });
  }
}

/**
 * Notes declaring `type: <name>` in any case and spacing, as `foldedTypeSql`
 * matches a type — what a relation may point at. One note listing it twice is one.
 */
export function notesOfType(database: Database, type: string): { path: string; title: string }[] {
  return database
    .selectArrays(
      `SELECT files.path, files.title FROM files
       WHERE files.path IN (SELECT path FROM props
                            WHERE key = 'type' AND lower(trim(value_text)) = lower(trim(?1)))
       ORDER BY files.title`,
      [type],
    )
    .map(([path, title]) => ({ path: String(path), title: String(title) }));
}

/** The notes whose body links to `path`, itself aside. */
export function backlinksOf(database: Database, path: string): string[] {
  return database
    .selectArrays('SELECT DISTINCT src FROM links WHERE dst = ?1 AND src <> ?1 ORDER BY src', [
      path,
    ])
    .map(([source]) => String(source));
}

export function statsOf(database: Database): IndexStats {
  const count = (table: string) => Number(database.selectValue(`SELECT COUNT(*) FROM ${table}`));
  return { notes: count('files'), properties: count('props'), links: count('links') };
}

/** A cell as the host hands it back: a number or text as it is, a blob as nothing. */
export function cellOf(value: SqlValue): string | number | null {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  // SQLite's integers are 64-bit; JavaScript's numbers hold 53, as the host's JSON does.
  if (typeof value === 'bigint') return Number(value);
  return null;
}

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
