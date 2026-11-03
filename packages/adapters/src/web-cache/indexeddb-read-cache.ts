import type { CachedRead, ReadCacheStore } from '@dfai/application';
import { indexedDbObjectStore } from './indexeddb-store.ts';

/** The browser's database the read cache lives in, one per origin. */
export const READ_CACHE_DATABASE = 'dfai-read-cache';
const READS = 'reads';

/**
 * The read cache's store in IndexedDB (#667): each kept read one record,
 * by its key. Thin: it keeps and hands back what it is given, and decides
 * nothing of what stays. The database is opened on the first call.
 */
export function indexedDbReadCache(
  factory: IDBFactory,
  name: string = READ_CACHE_DATABASE,
): ReadCacheStore {
  const inStore = indexedDbObjectStore({ factory, database: name, store: READS });
  return {
    get: async (key) =>
      ((await inStore('readonly', (store) => store.get(key))) as CachedRead) ?? null,
    put: async (entry) => void (await inStore('readwrite', (store) => store.put(entry))),
    touch: async (key, usedAt) =>
      void (await inStore('readwrite', (store) => {
        const reading = store.get(key);
        reading.onsuccess = () => {
          const entry = reading.result as CachedRead | undefined;
          if (entry !== undefined) store.put({ ...entry, usedAt });
        };
      })),
    remove: async (keys) =>
      void (await inStore('readwrite', (store) => {
        for (const key of keys) store.delete(key);
      })),
    facts: async () => {
      const all = ((await inStore('readonly', (store) => store.getAll())) ?? []) as CachedRead[];
      return all.map(({ key, bytes, usedAt }) => ({ key, bytes, usedAt }));
    },
    clear: async () => void (await inStore('readwrite', (store) => store.clear())),
  };
}
