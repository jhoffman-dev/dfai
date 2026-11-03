/**
 * What the web build keeps of the vault in the browser (#667): the notes the
 * person has opened and the tree they have walked, so both open with no
 * network. The cache is capped, and what was used longest ago goes first.
 *
 * This is policy only. The bytes live in IndexedDB behind a port; the clock
 * that says when an entry was used is injected where the cache is kept.
 */

/** 50 MB: hundreds of notes, well inside what Safari grants an origin before it asks. */
export const READ_CACHE_CAP_BYTES = 50 * 1024 * 1024;

/** One kept read, as far as eviction needs to know it. */
export interface CachedReadFacts {
  readonly key: string;
  /** What it costs to keep, in bytes as UTF-16 text (what IndexedDB stores a string as). */
  readonly bytes: number;
  /** When it was last read or written, by the injected clock. */
  readonly usedAt: number;
}

/** The kinds of read that are kept: a note's text, and each listing of the tree. */
export type CachedReadKind = 'note' | 'directory' | 'notes' | 'files';

const SEPARATOR = '\u0000';

/**
 * The key a read is kept under: whose it is (the account and vault, so one
 * person's notes are never answered to another), its kind and what it asked
 * for, which never collide.
 */
export function cachedReadKey(scope: string, kind: CachedReadKind, asked: string): string {
  return `${scope}${SEPARATOR}${kind}${SEPARATOR}${asked}`;
}

/** Whose a key is, the kind it was made for, and the path or arguments it names. */
export function cachedReadOf(key: string): { scope: string; kind: CachedReadKind; asked: string } {
  const first = key.indexOf(SEPARATOR);
  const second = key.indexOf(SEPARATOR, first + 1);
  return {
    scope: key.slice(0, first),
    kind: key.slice(first + 1, second) as CachedReadKind,
    asked: key.slice(second + 1),
  };
}

/** The bytes a value costs to keep: its JSON, two bytes a character. */
export function cachedReadBytes(value: unknown): number {
  return JSON.stringify(value).length * 2;
}

/**
 * The keys to drop so everything kept fits in `capBytes`, least recently used
 * first. Ties go in key order, so the answer never depends on how the store
 * listed them. A cache already within its cap drops nothing.
 */
export function evictionsToFit(
  entries: readonly CachedReadFacts[],
  capBytes: number,
): readonly string[] {
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= capBytes) return [];
  const oldestFirst = [...entries].sort(
    (a, b) => a.usedAt - b.usedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const dropped: string[] = [];
  for (const entry of oldestFirst) {
    if (total <= capBytes) break;
    dropped.push(entry.key);
    total -= entry.bytes;
  }
  return dropped;
}

/** Whether one read can be kept at all: one larger than the whole cap never is. */
export function fitsInReadCache(bytes: number, capBytes: number): boolean {
  return bytes <= capBytes;
}

/**
 * Whether a kept note goes stale once the tree says where each note stands:
 * gone from it, or at a version other than the one kept (a version, never a
 * time: ADR-0053).
 */
export function isCachedNoteStale(kept: number, listed: number | undefined): boolean {
  return listed === undefined || listed !== kept;
}
