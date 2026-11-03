/**
 * One object store in a database of its own, keyed by each record's `key`
 * (#667): what the read cache and the save queue are kept in. The database
 * is opened on the first call, and again after a call that could not open it.
 */
export function indexedDbObjectStore({
  factory,
  database: name,
  store: storeName,
}: {
  factory: IDBFactory;
  database: string;
  store: string;
}) {
  let database: Promise<IDBDatabase> | null = null;
  return async <T>(
    mode: IDBTransactionMode,
    act: (store: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T | undefined> => {
    database ??= opened(factory, name, storeName).catch((error: unknown) => {
      database = null;
      throw error;
    });
    const transaction = (await database).transaction(storeName, mode);
    const request = act(transaction.objectStore(storeName));
    // Resolved once the transaction is done, so a write is on disk before its caller goes on.
    const [result] = await Promise.all([
      request ? answered(request) : undefined,
      finished(transaction),
    ]);
    return result;
  };
}

export type InObjectStore = ReturnType<typeof indexedDbObjectStore>;

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

function opened(factory: IDBFactory, name: string, storeName: string): Promise<IDBDatabase> {
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'key' });
  return answered(request);
}
