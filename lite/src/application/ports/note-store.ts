import type { VaultPath } from '../../domain/vault/index.ts';

/**
 * One vault file as this device holds it. Notes and the app's own synced
 * files (`.dfai-lite/favorites.json`) alike: the store does not tell them apart.
 */
export interface StoredFile {
  readonly path: VaultPath;
  readonly text: string;
  /**
   * The git blob sha of the remote version this text was last in step with,
   * or null for a file never synced (made here, or a conflict copy).
   */
  readonly baseSha: string | null;
  /** True when the text changed here since it was last in step with the remote. */
  readonly dirty: boolean;
}

/**
 * Every vault file on this device (IndexedDB in the app): the app opens from
 * here with no network, and every edit lands here first.
 *
 * A deleted file is simply gone. Sync works out what this device deleted by
 * comparing the files here with the remote tree it last saw (kept with
 * `setState`), so the store keeps no tombstones.
 *
 * Writes are atomic per call. The store decides nothing: it keeps exactly
 * what it is given, and `list` returns files sorted by path.
 */
export interface NoteStore {
  list(): Promise<StoredFile[]>;
  get(path: VaultPath): Promise<StoredFile | null>;
  /** Writes the file, replacing any at its path. */
  put(file: StoredFile): Promise<void>;
  /** Removes the file; no error when there is none. */
  delete(path: VaultPath): Promise<void>;
  /** Removes `from` and writes `to` in one step, so a crash leaves one or the other. */
  rename(from: VaultPath, to: StoredFile): Promise<void>;
  /**
   * A small key/value beside the files, for sync's own state: the last remote
   * commit and tree seen, as JSON strings the sync use-case owns. Null when unset.
   */
  getState(key: string): Promise<string | null>;
  setState(key: string, value: string): Promise<void>;
}
