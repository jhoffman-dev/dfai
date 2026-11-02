import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { IndexFiles } from './wasm-index-host.ts';

/**
 * Index files kept as bytes in memory, for where there is no OPFS: Node, in
 * the tests and the work budgets. A file is the database's bytes as SQLite
 * wrote them out on close, and opening one reads them back in, so a re-open
 * is a real round trip through SQLite's own file format.
 */
export interface MemoryIndexFiles extends IndexFiles {
  /** Each vault's file as it was last closed or kept. */
  readonly stored: Map<string, Uint8Array>;
  /**
   * Writes out each database still open, as a page going away leaves its
   * OPFS files: what a re-open in the same test then reads back.
   */
  keep(): void;
}

export function memoryIndexFiles(sqlite3: Sqlite3Static): MemoryIndexFiles {
  const stored = new Map<string, Uint8Array>();
  const opened = new Map<string, Database>();
  const { capi, wasm } = sqlite3;
  return {
    stored,
    keep() {
      for (const [vault, database] of opened)
        stored.set(vault, capi.sqlite3_js_db_export(database));
    },
    open(vault) {
      const database = new sqlite3.oo1.DB(':memory:');
      const bytes = stored.get(vault);
      if (bytes !== undefined && bytes.byteLength > 0) {
        const memory = wasm.allocFromTypedArray(bytes);
        const flags = capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE;
        database.checkRc(
          capi.sqlite3_deserialize(
            database,
            'main',
            memory,
            bytes.byteLength,
            bytes.byteLength,
            flags,
          ),
        );
      }
      opened.set(vault, database);
      return database;
    },
    close(vault, database: Database) {
      opened.delete(vault);
      try {
        stored.set(vault, capi.sqlite3_js_db_export(database));
      } finally {
        database.close();
      }
    },
    discard(vault) {
      stored.delete(vault);
    },
  };
}
