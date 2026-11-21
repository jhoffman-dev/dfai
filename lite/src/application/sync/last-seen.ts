import { INDEX_FOLDER, type VaultPath } from '../../domain/vault/index.ts';
import type { NoteStore, RemoteHead } from '../ports/index.ts';

/** The remote tree as this device last saw it: its head and every file's blob sha. */
export interface LastSeen {
  /** Which repository and branch it was seen on (`SyncDeps.remoteIdentity`). */
  readonly identity: string;
  readonly head: RemoteHead | null;
  /** The remote tree at `head`, exactly. */
  readonly entries: ReadonlyMap<VaultPath, string>;
  /**
   * Paths whose remote change was not applied here (the file changed while
   * the pull ran), with the base they must still be decided against: their
   * entry in `entries` is newer than anything this device has seen of them.
   */
  readonly heldBases: ReadonlyMap<VaultPath, string | null>;
}

const KEY = 'sync.lastSeen';

/** Files sync generates, never keeps here, and never pulls. */
export const isDerivedPath = (path: VaultPath): boolean => path.startsWith(`${INDEX_FOLDER}/`);

/** The base a path deleted here is decided against. */
export function lastBase(seen: LastSeen | null, path: VaultPath): string | null {
  if (seen === null) return null;
  if (seen.heldBases.has(path)) return seen.heldBases.get(path) ?? null;
  return seen.entries.get(path) ?? null;
}

interface Stored {
  identity?: unknown;
  head?: RemoteHead | null;
  entries?: Record<string, string>;
  heldBases?: Record<string, string | null>;
}

const isRecord = (value: unknown): value is Record<string, never> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What was last seen, or null when never (or when it cannot be read: every
 * path is then compared afresh). An entry saved before identities were kept
 * is taken as this remote's.
 */
export async function loadLastSeen(store: NoteStore, identity: string): Promise<LastSeen | null> {
  const raw = await store.getState(KEY);
  if (raw === null) return null;
  let stored: Stored;
  try {
    stored = JSON.parse(raw) as Stored;
  } catch {
    // Unreadable state reads as "never synced".
    return null;
  }
  if (!isRecord(stored) || !isRecord(stored.entries)) return null;
  return {
    identity: typeof stored.identity === 'string' ? stored.identity : identity,
    head: stored.head ?? null,
    entries: new Map(Object.entries(stored.entries)),
    heldBases: new Map(Object.entries(isRecord(stored.heldBases) ? stored.heldBases : {})),
  };
}

export async function saveLastSeen(store: NoteStore, seen: LastSeen): Promise<void> {
  await store.setState(
    KEY,
    JSON.stringify({
      identity: seen.identity,
      head: seen.head,
      entries: Object.fromEntries(seen.entries),
      heldBases: Object.fromEntries(seen.heldBases),
    }),
  );
}
