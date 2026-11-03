import type { CachedReadFacts } from '@dfai/domain';

/** One read kept on this device (#667): what it answered, and what eviction needs. */
export interface CachedRead extends CachedReadFacts {
  /** What the read answered, as structured clone keeps it. */
  readonly value: unknown;
}

/**
 * Where the web build keeps the reads it may answer with no network:
 * IndexedDB in the browser, memory in a test. A thin store: what is kept,
 * for how long and what goes first are decided above it.
 */
export interface ReadCacheStore {
  get(key: string): Promise<CachedRead | null>;
  /** Keeps `entry` under its key, over whatever was there. */
  put(entry: CachedRead): Promise<void>;
  /** Marks the entry used at `usedAt`; nothing when it is not kept. */
  touch(key: string, usedAt: number): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
  /** Every entry kept, without its value. */
  facts(): Promise<readonly CachedReadFacts[]>;
  /** Forgets everything kept. */
  clear(): Promise<void>;
}

/** Whether the device is online, as the browser says, and each time that changes. */
export interface ConnectionPort {
  online(): boolean;
  /** Calls `listener` on each change; the answer stops it. */
  onChange(listener: (online: boolean) => void): () => void;
}
