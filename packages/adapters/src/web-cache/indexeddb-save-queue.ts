import type { SaveQueueStore } from '@dfai/application';
import type { QueuedSave } from '@dfai/domain';
import { indexedDbObjectStore } from './indexeddb-store.ts';

/** The browser's database the saves made offline wait in. */
export const SAVE_QUEUE_DATABASE = 'dfai-save-queue';
const SAVES = 'saves';

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
  return {
    all: async () => ((await inStore('readonly', (store) => store.getAll())) ?? []) as QueuedSave[],
    get: async (key) =>
      ((await inStore('readonly', (store) => store.get(key))) as QueuedSave | undefined) ?? null,
    put: async (save) => void (await inStore('readwrite', (store) => store.put(save))),
    remove: async (key) => void (await inStore('readwrite', (store) => store.delete(key))),
    clear: async () => void (await inStore('readwrite', (store) => store.clear())),
  };
}
