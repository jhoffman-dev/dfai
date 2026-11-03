import type { QueuedSave } from '@dfai/domain';
import type {
  CachedRead,
  ConnectionPort,
  ReadCacheStore,
  SaveQueueStore,
} from '../web-cache/ports.ts';

/** The read cache's store in memory, for tests: what IndexedDB holds in the browser. */
export function memoryReadCacheStore(): ReadCacheStore & {
  readonly held: Map<string, CachedRead>;
} {
  const held = new Map<string, CachedRead>();
  return {
    held,
    get: async (key) => held.get(key) ?? null,
    put: async (entry) => {
      held.set(entry.key, structuredClone(entry));
    },
    touch: async (key, usedAt) => {
      const entry = held.get(key);
      if (entry !== undefined) held.set(key, { ...entry, usedAt });
    },
    remove: async (keys) => {
      for (const key of keys) held.delete(key);
    },
    facts: async () => [...held.values()].map(({ key, bytes, usedAt }) => ({ key, bytes, usedAt })),
    clear: async () => held.clear(),
  };
}

/** A connection a test turns on and off, telling each listener as the browser would. */
export function switchableConnection(
  online = true,
): ConnectionPort & { set(online: boolean): void } {
  let now = online;
  const listeners = new Set<(online: boolean) => void>();
  return {
    online: () => now,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      now = next;
      for (const listener of listeners) listener(next);
    },
  };
}

/** The offline save queue's store in memory, for tests: a reload is a new queue over the same store. */
export function memorySaveQueueStore(): SaveQueueStore & {
  readonly held: Map<string, QueuedSave>;
} {
  const held = new Map<string, QueuedSave>();
  return {
    held,
    all: async () => [...held.values()].map((save) => structuredClone(save)),
    get: async (key) => {
      const save = held.get(key);
      return save === undefined ? null : structuredClone(save);
    },
    put: async (save) => {
      held.set(save.key, structuredClone(save));
    },
    remove: async (key) => {
      held.delete(key);
    },
    clear: async () => held.clear(),
  };
}

/** One lock the tabs of a test share, as Web Locks is one per origin: each task after the last. */
export function memoryQueueLock(): <T>(task: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = last.then(task, task);
    last = run.catch(() => undefined);
    return run;
  };
}

/** The tabs of a test telling each other the queue changed, as a BroadcastChannel would, never to the teller. */
export function sharedQueueChanges() {
  const listeners = new Set<() => void>();
  return () => {
    const mine = new Set<() => void>();
    return {
      announce: () => {
        for (const listener of listeners) if (!mine.has(listener)) listener();
      },
      listen: (listener: () => void) => {
        mine.add(listener);
        listeners.add(listener);
        return () => {
          mine.delete(listener);
          listeners.delete(listener);
        };
      },
    };
  };
}
