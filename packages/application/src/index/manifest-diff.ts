import type { IndexEntry } from './ports.ts';

/** A note as the vault lists it: what is held against the index's manifest. */
export interface ListedNote {
  readonly path: string;
  /** Its version (ADR-0053): a time on the desktop, a blob id's prefix on GitHub. */
  readonly modified: number;
  readonly size: number;
}

/** What the vault changed since the index last held it. */
export interface ManifestDiff<Listed extends ListedNote> {
  /** The notes to read again: new, of another version or size, or named to be rechecked. */
  readonly stale: Listed[];
  /** The notes the index holds that the vault no longer lists. */
  readonly removed: string[];
  /** The notes the vault lists that the index has never held. */
  readonly added: string[];
}

/**
 * The listing held against the manifest, by path: the one rule for which
 * notes a refresh reads (#666). A note is read again only when its version or
 * size differs from what the index holds, so re-opening a vault reads only
 * what changed; `recheck` names notes whose bytes may have changed under a
 * version and size that did not (#245).
 */
export function diffManifest<Listed extends ListedNote>({
  listed,
  held,
  recheck = [],
}: {
  listed: readonly Listed[];
  held: ReadonlyMap<string, Pick<IndexEntry, 'modified' | 'size'>>;
  recheck?: readonly string[];
}): ManifestDiff<Listed> {
  const named = new Set(recheck);
  const listedPaths = new Set(listed.map((note) => note.path));
  const stale = listed.filter((note) => {
    const entry = held.get(note.path);
    return (
      entry === undefined ||
      entry.modified !== note.modified ||
      entry.size !== note.size ||
      named.has(note.path)
    );
  });
  return {
    stale,
    removed: [...held.keys()].filter((path) => !listedPaths.has(path)),
    added: [...listedPaths].filter((path) => !held.has(path)),
  };
}
