import { isNotePath, type VaultPath } from './note-path.ts';

/** The generated index: derived, never edited, never shown as notes. */
export const INDEX_FOLDER = '_index';

/** The app's own synced state, such as favourites. */
export const APP_FOLDER = '.dfai-lite';

/**
 * Whether a path is kept out of the tree, the index and search: anything
 * under `_index/` or `.dfai-lite/`, and any file or folder whose name starts
 * with a dot (`.github/`, `.gitignore`).
 */
export function isHiddenPath(path: VaultPath): boolean {
  if (path === INDEX_FOLDER || path.startsWith(`${INDEX_FOLDER}/`)) return true;
  return path.split('/').some((part) => part.startsWith('.'));
}

/** Whether a file is a note the app shows: markdown, and not hidden. */
export function isVisibleNote(path: VaultPath): boolean {
  return isNotePath(path) && !isHiddenPath(path);
}
