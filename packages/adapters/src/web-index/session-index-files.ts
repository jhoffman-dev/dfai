import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { IndexFiles } from './wasm-index-host.ts';

/**
 * Index files for a browser that will not store them (#761): each open is a
 * new database in memory, gone when it is closed, so the index is rebuilt
 * from the vault every time it is opened.
 */
export function sessionIndexFiles(sqlite3: Sqlite3Static): IndexFiles {
  return {
    open: () => new sqlite3.oo1.DB(':memory:'),
    close: (_, database) => database.close(),
    // Nothing outlives a close, so there is nothing to throw away.
    discard: () => undefined,
  };
}
