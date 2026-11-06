import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { IndexFiles } from './wasm-index-host.ts';

/**
 * Index files for a browser that will not store them (#761): each vault's
 * database in memory, kept open for the worker's life as OPFS would keep its
 * file, so the app's re-opens find what was built, views and all. Nothing
 * outlives the page: the next visit rebuilds the index from the vault.
 */
export function sessionIndexFiles(sqlite3: Sqlite3Static): IndexFiles {
  const held = new Map<string, Database>();
  return {
    open(vault) {
      const kept = held.get(vault);
      if (kept !== undefined) return kept;
      const made = new sqlite3.oo1.DB(':memory:');
      held.set(vault, made);
      return made;
    },
    // Closing a database in memory would throw it away; it is let go only by discard.
    close: () => undefined,
    discard(vault) {
      held.get(vault)?.close();
      held.delete(vault);
    },
  };
}
