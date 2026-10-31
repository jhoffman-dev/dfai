import {
  createVaultPath,
  isMarkdownFile,
  isVisibleEntry,
  isWithinWalk,
  vaultPathName,
  type VaultEntry,
} from '@dfai/domain';

/** The watched path as a file entry, or null when it is not one a vault can hold. */
function asFile(path: string): VaultEntry | null {
  try {
    const vaultPath = createVaultPath(path);
    return { kind: 'file', name: vaultPathName(vaultPath), path: vaultPath };
  } catch {
    // A path the vault cannot name is nothing the index holds: the caller treats it as anything else.
    return null;
  }
}

/** Whether the index holds this path: a note the vault walk lists (`listVaultNoteFiles`). */
function isIndexedNote(path: string): boolean {
  const file = asFile(path);
  return file !== null && isMarkdownFile(file) && isVisibleEntry(file) && isWithinWalk(path);
}

/**
 * Whether a watcher event may ask for a quiet refresh: one that moves the
 * index's revision only when the index found something (#238). Only when
 * every path is a note the index holds can the refresh see the whole change.
 * A template, a view, a dashboard, an attachment or a folder is not in the
 * index, so its readers — and the push schedule — hear of it only through a
 * loud refresh.
 */
export function watchedPathsAreIndexedNotes(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(isIndexedNote);
}

/**
 * The refresh a watcher event asks for. It reads every path again whatever
 * its time and size, which another program's write within the same tick of a
 * coarse disk's clock can leave as they were (#245); the refresh ignores the
 * paths that are not notes.
 */
export function refreshAfterWatch(paths: readonly string[]): {
  quiet: boolean;
  recheck: readonly string[];
} {
  return { quiet: watchedPathsAreIndexedNotes(paths), recheck: paths };
}
