import type { CachedRead, ReadCacheStore } from '@dfai/application';

/** The browser's database the read cache lives in, one per origin. */
export const READ_CACHE_DATABASE = 'dfai-read-cache';
const READS = 'reads';

const answered = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused the request'));
  });

const finished = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB failed'));
  });

function opened(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(READS, { keyPath: 'key' });
  return answered(request);
}

/**
 * The read cache's store in IndexedDB (#667): each kept read one record,
 * by its key. Thin: it keeps and hands back what it is given, and decides
 * nothing of what stays. The database is opened on the first call.
 */
export function indexedDbReadCache(
  factory: IDBFactory,
  name: string = READ_CACHE_DATABASE,
): ReadCacheStore {
  let database: Promise<IDBDatabase> | null = null;
  const inStore = async <T>(
    mode: IDBTransactionMode,
    act: (store: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T | undefined> => {
    database ??= opened(factory, name).catch((error: unknown) => {
      database = null;
      throw error;
    });
    const transaction = (await database).transaction(READS, mode);
    const request = act(transaction.objectStore(READS));
    const [result] = await Promise.all([
      request ? answered(request) : undefined,
      finished(transaction),
    ]);
    return result;
  };
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
