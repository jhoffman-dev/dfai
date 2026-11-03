import type { CachedReadFacts, QueuedSave } from '@dfai/domain';

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

/**
 * Where saves made offline wait (#667): IndexedDB in the browser, so they
 * outlive a reload. A save is resolved only once it is here, and a write
 * that cannot be kept fails: a save the person was told is waiting is never
 * only in memory.
 */
export interface SaveQueueStore {
  all(): Promise<readonly QueuedSave[]>;
  put(save: QueuedSave): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** A note's save waiting on the device: to be sent, or refused once sent and why. */
export type PendingSaveState =
  { readonly kind: 'waiting' } | { readonly kind: 'refused'; readonly reason: string };

/**
 * The saves waiting on the device, as a pane shows them (#667): "Not saved
 * yet", or a refused save's way out — kept as a copy beside the newer note,
 * or discarded. Only the web has one; a platform without it has no queue.
 */
export interface PendingSavesPort {
  stateOf(vault: string, path: string): PendingSaveState | null;
  /** Calls `listener` on every change; the answer stops it. */
  subscribe(listener: () => void): () => void;
  /** Keeps a refused save's text as a conflict copy, then lets it go. */
  keepAsCopy(vault: string, path: string): Promise<void>;
  /** Lets a refused save go: the note keeps what GitHub has. */
  discard(vault: string, path: string): Promise<void>;
}
