import { INDEX_SCHEMA } from './index-schema.ts';
import { DatabaseSync } from './node-sqlite.ts';
import type { VaultPath } from '@dfai/domain';
import type { IndexedNote, IndexEntry, IndexPort, QueryResult } from '../index/ports.ts';

/**
 * An index that keeps what it is handed in SQLite, in the tables the host
 * makes (`index_schema.sql`), with the host's statements (`index.rs`): a put
 * replaces the note's rows and its search rows, `files.modified` is the
 * version it is handed, as the desktop's is, and a query only reads. Search,
 * backlinks, a type's notes and its views answer as the host's do, so the
 * index contract (`index-contract.ts`) holds it and the browser's index to
 * the same answers (#666). Test support only.
 */
export function sqliteIndexPort(): IndexPort {
  const database = new DatabaseSync(':memory:');
  database.exec(INDEX_SCHEMA);
  return {
    open: async () => ({ fresh: false }),
    clear: async () => {
      for (const table of [...TABLES.map(([table]) => table), 'fts', 'highlights_fts']) {
        database.exec(`DELETE FROM ${table}`);
      }
    },
    manifest: async () =>
      (
        database
          .prepare('SELECT path, modified, size, digest, note_type AS type FROM files')
          .all() as unknown as IndexEntry[]
      ).map((entry) => ({ ...entry, type: entry.type ?? null })),
    put: async (notes) => {
      for (const note of notes) {
        removeNote(database, note.path);
        insertNote(database, note);
      }
    },
    remove: async (paths: readonly VaultPath[]) => {
      for (const path of paths) removeNote(database, path);
    },
    search: async (query, limit, scope = {}) => {
      const skip = scope.skipPrefix ?? null;
      const notes = database.prepare(NOTE_SEARCH).all(query, limit, skip) as unknown as Hit[];
      if (scope.highlights !== true) return notes;
      return [
        ...notes,
        ...(database.prepare(HIGHLIGHT_SEARCH).all(query, limit, skip) as unknown as Hit[]),
      ];
    },
    notesOfType: async (type) =>
      database
        .prepare(
          `SELECT files.path, files.title FROM files
           WHERE files.path IN (SELECT path FROM props
                                WHERE key = 'type' AND lower(trim(value_text)) = lower(trim(?)))
           ORDER BY files.title`,
        )
        .all(type) as unknown as { path: string; title: string }[],
    rebuildViews: async (types) => {
      const views = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'v\\_%' ESCAPE '\\'",
        )
        .all() as { name: string }[];
      for (const { name } of views) database.exec(`DROP VIEW IF EXISTS "${name}"`);
      for (const spec of types) database.exec(`CREATE VIEW "v_${spec.name}" AS\n${spec.select}`);
    },
    query: async (sql, parameters): Promise<QueryResult> => readOnly(database, sql, parameters),
    backlinks: async (path) =>
      (
        database
          .prepare('SELECT DISTINCT src FROM links WHERE dst = ?1 AND src <> ?1 ORDER BY src')
          .all(path) as { src: string }[]
      ).map(({ src }) => src),
    stats: async () => {
      const count = (table: string) =>
        Number((database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      return { notes: count('files'), properties: count('props'), links: count('links') };
    },
  };
}

type Hit = { path: string; title: string; snippet: string; block?: string };

const NOTE_SEARCH = `SELECT files.path AS path, fts.title AS title,
    snippet(fts, 2, '<<', '>>', '…', 12) AS snippet
  FROM fts JOIN files ON files.rowid = fts.rowid
  WHERE fts MATCH ?1 AND (?3 IS NULL OR lower(substr(files.path, 1, length(?3))) <> ?3)
  ORDER BY bm25(fts, 5.0, 10.0, 1.0) LIMIT ?2`;

const HIGHLIGHT_SEARCH = `SELECT highlights.path AS path, files.title AS title,
    snippet(highlights_fts, -1, '<<', '>>', '…', 12) AS snippet, highlights.id AS block
  FROM highlights_fts
  JOIN highlights ON highlights.rowid = highlights_fts.rowid
  JOIN files ON files.path = highlights.path
  WHERE highlights_fts MATCH ?1 AND (?3 IS NULL OR lower(substr(files.path, 1, length(?3))) <> ?3)
  ORDER BY bm25(highlights_fts), highlights.path, highlights.idx LIMIT ?2`;

/** A query that only reads, as the host's read-only connection runs it: one statement, no writes. */
function readOnly(
  database: DatabaseSync,
  sql: string,
  parameters: readonly (string | number | null)[],
): QueryResult {
  database.exec('PRAGMA query_only = 1');
  try {
    const statement = database.prepare(sql);
    if (sql.slice(statement.sourceSQL.length).trim() !== '') {
      throw new Error('only a statement that reads the index can run here');
    }
    const rows = statement.all(...parameters) as Record<string, unknown>[];
    const columns = statement.columns().map((column) => column.name);
    return {
      columns,
      rows: rows.map((row) => columns.map((column) => row[column] ?? null)),
      truncated: false,
    };
  } finally {
    database.exec('PRAGMA query_only = 0');
  }
}

const TABLES: readonly (readonly [string, string])[] = [
  ['files', 'path'],
  ['props', 'path'],
  ['relations', 'src'],
  ['tags', 'path'],
  ['links', 'src'],
  ['blocks', 'path'],
  ['checks', 'path'],
  ['highlights', 'path'],
];

function removeNote(database: DatabaseSync, path: string): void {
  database
    .prepare('DELETE FROM fts WHERE rowid = (SELECT rowid FROM files WHERE path = ?)')
    .run(path);
  database
    .prepare(
      'DELETE FROM highlights_fts WHERE rowid IN (SELECT rowid FROM highlights WHERE path = ?)',
    )
    .run(path);
  for (const [table, column] of TABLES) {
    database.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(path);
  }
}

function insertNote(database: DatabaseSync, note: IndexedNote): void {
  const { lastInsertRowid } = database
    .prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      note.path,
      note.title,
      note.summary,
      note.modified,
      note.size,
      note.digest,
      note.type,
      note.progress,
    );
  database
    .prepare('INSERT INTO fts (rowid, path, title, body) VALUES (?, ?, ?, ?)')
    .run(lastInsertRowid, fileStem(note.path), note.title, note.body);
  for (const row of note.properties) {
    database
      .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(note.path, row.key, row.index, row.text, row.number, row.date, row.json);
  }
  for (const row of note.relations) {
    database
      .prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)')
      .run(note.path, row.key, row.index, row.target, row.name, row.path);
  }
  note.tags.forEach((tag, at) =>
    database.prepare('INSERT INTO tags VALUES (?, ?, ?, ?)').run(note.path, at, tag.key, tag.name),
  );
  for (const link of note.links) {
    database
      .prepare('INSERT INTO links VALUES (?, ?, ?, ?, ?)')
      .run(note.path, link.path, link.target, link.kind, link.leaf);
  }
  note.blocks.forEach((block, at) =>
    database
      .prepare('INSERT INTO blocks VALUES (?, ?, ?, ?)')
      .run(note.path, at, block.id, block.text),
  );
  note.checks.forEach((check, at) =>
    database
      .prepare('INSERT INTO checks VALUES (?, ?, ?, ?)')
      .run(note.path, at, check.done ? 1 : 0, check.text),
  );
  note.highlights.forEach((row, at) => {
    const inserted = database
      .prepare('INSERT INTO highlights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        note.path,
        at,
        row.id,
        row.kind,
        row.quote,
        row.comment,
        row.mark,
        row.color,
        row.anchor,
      );
    database
      .prepare('INSERT INTO highlights_fts (rowid, quote, comment) VALUES (?, ?, ?)')
      .run(inserted.lastInsertRowid, row.quote, row.comment);
  });
}

/** The file name without its extension: what the host searches of a path (#211). */
const fileStem = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};
