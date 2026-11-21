import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { NoteStore, StoredFile } from '../../application/index.ts';

interface VaultDb extends DBSchema {
  files: { key: string; value: StoredFile };
  state: { key: string; value: string };
}

const VERSION = 1;

/**
 * The vault's files in IndexedDB: one record per file, keyed by path, plus
 * sync's small key/value. IndexedDB orders string keys as `<` does, so
 * `list` comes back sorted by path with no sort here.
 */
export async function openIdbNoteStore(databaseName: string): Promise<NoteStore> {
  const db = await openDB<VaultDb>(databaseName, VERSION, {
    upgrade(database) {
      database.createObjectStore('files', { keyPath: 'path' });
      database.createObjectStore('state');
    },
  });
  return idbNoteStore(db);
}

function idbNoteStore(db: IDBPDatabase<VaultDb>): NoteStore {
  return {
    list: () => db.getAll('files'),
    get: async (path) => (await db.get('files', path)) ?? null,
    put: async (file) => {
      await db.put('files', copyOf(file));
    },
    delete: (path) => db.delete('files', path),
    rename: async (from, to) => {
      const transaction = db.transaction('files', 'readwrite');
      // Both in one transaction: it commits whole, or not at all. A request
      // refused as it is made throws without failing the transaction, so it
      // is aborted here, or the delete alone would commit.
      const deleted = transaction.store.delete(from);
      try {
        await transaction.store.put(copyOf(to));
        await deleted;
        await transaction.done;
      } catch (error) {
        // Their rejections only echo the abort below; the cause is `error`.
        deleted.catch(() => undefined);
        transaction.done.catch(() => undefined);
        abortQuietly(transaction);
        throw error;
      }
    },
    getState: async (key) => (await db.get('state', key)) ?? null,
    setState: async (key, value) => {
      await db.put('state', value, key);
    },
  };
}

function abortQuietly(transaction: { abort(): void }): void {
  try {
    transaction.abort();
  } catch {
    // Already finished (it failed on its own, and rolled back): nothing to undo.
  }
}

/** Only the fields the port names, so a caller's extra properties are never kept. */
const copyOf = ({ path, text, baseSha, dirty }: StoredFile): StoredFile => ({
  path,
  text,
  baseSha,
  dirty,
});
