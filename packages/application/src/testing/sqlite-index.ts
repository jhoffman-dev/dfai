import { INDEX_SCHEMA } from './index-schema.ts';
import { DatabaseSync } from './node-sqlite.ts';
import type { VaultPath } from '@dfai/domain';
import type { IndexedNote, IndexEntry, IndexPort, QueryResult } from '../index/ports.ts';

/**
 * An index that keeps what it is handed in SQLite, in the tables the host
 * makes (`index_schema.sql`), so a sync writes it and a compiled query
 * reads it back for real. A put replaces the note's rows, as the host's does.
 * Views, search and backlinks are not kept. Test support only.
 */
export function sqliteIndexPort(): IndexPort {
  const database = new DatabaseSync(':memory:');
  database.exec(INDEX_SCHEMA);
  const removeNote = (path: string) => {
    for (const [table, column] of TABLES) {
      database.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(path);
    }
  };
  return {
    open: async () => ({ fresh: false }),
    clear: async () => {
      for (const [table] of TABLES) database.exec(`DELETE FROM ${table}`);
    },
    manifest: async () =>
      (
        database
          .prepare('SELECT path, modified, size, digest, note_type AS type FROM files')
          .all() as unknown as IndexEntry[]
      ).map((entry) => ({ ...entry, type: entry.type ?? null })),
    put: async (notes) => {
      for (const note of notes) {
        removeNote(note.path);
        insertNote(database, note);
      }
    },
    remove: async (paths: readonly VaultPath[]) => {
      for (const path of paths) removeNote(path);
    },
    search: async () => [],
    notesOfType: async () => [],
    rebuildViews: async () => {},
    query: async (sql, parameters): Promise<QueryResult> => {
      const statement = database.prepare(sql);
      const rows = statement.all(...parameters) as Record<string, unknown>[];
      const columns = statement.columns().map((column) => column.name);
      return {
        columns,
        rows: rows.map((row) => columns.map((column) => row[column] ?? null)),
        truncated: false,
      };
    },
    backlinks: async () => [],
    stats: async () => ({
      notes: Number((database.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n),
      properties: 0,
      links: 0,
    }),
  };
}

const TABLES: readonly (readonly [string, string])[] = [
  ['files', 'path'],
  ['props', 'path'],
  ['relations', 'src'],
  ['tags', 'path'],
  ['links', 'src'],
  ['highlights', 'path'],
];

function insertNote(database: DatabaseSync, note: IndexedNote): void {
  database
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
  note.highlights.forEach((row, at) =>
    database
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
      ),
  );
}
