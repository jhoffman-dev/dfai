import type { SaveQueueStore } from '@dfai/application';
import type { QueuedSave } from '@dfai/domain';
import { indexedDbObjectStore } from './indexeddb-store.ts';

/** The browser's database the saves made offline wait in. */
export const SAVE_QUEUE_DATABASE = 'dfai-save-queue';
const SAVES = 'saves';
/** The record marking the queue closed by a sign-out: a key no note's save can have. */
const CLOSED = '\u0000closed';
const isSave = (record: { key: string }) => record.key !== CLOSED;

/**
 * The offline save queue in IndexedDB (#667): each waiting save one record,
 * by its note. Each call resolves once its transaction is complete, so a
 * save the person was told is waiting is on disk. Thin: what waits, and in
 * what order it is sent, is the queue's to say.
 */
export function indexedDbSaveQueue(
  factory: IDBFactory,
  name: string = SAVE_QUEUE_DATABASE,
): SaveQueueStore {
  // Strict: Safari may otherwise report a write done before it is on disk, and a save is only waiting once it is.
  const inStore = indexedDbObjectStore({
    factory,
    database: name,
    store: SAVES,
    durability: 'strict',
  });
  const isClosed = async () =>
    (await inStore('readonly', (store) => store.get(CLOSED))) !== undefined;
  return {
    all: async () =>
      (((await inStore('readonly', (store) => store.getAll())) ?? []) as QueuedSave[]).filter(
        isSave,
      ),
    get: async (key) =>
      ((await inStore('readonly', (store) => store.get(key))) as QueuedSave | undefined) ?? null,
    put: async (save) => void (await inStore('readwrite', (store) => store.put(save))),
    remove: async (key) => void (await inStore('readwrite', (store) => store.delete(key))),
    clear: async () => {
      const closed = await isClosed();
      await inStore('readwrite', (store) => {
        store.clear();
        if (closed) store.put({ key: CLOSED });
      });
    },
    isClosed,
    setClosed: async (closed) =>
      void (await inStore('readwrite', (store) => {
        if (closed) store.put({ key: CLOSED });
        else store.delete(CLOSED);
      })),
  };
}
