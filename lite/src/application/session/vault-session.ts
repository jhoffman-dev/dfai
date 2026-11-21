import {
  FAVORITES_PATH,
  parseFavorites,
  type Favorites,
  type ParsedFavorites,
} from '../../domain/favorites/index.ts';
import { VaultIndex } from '../../domain/index/index.ts';
import { buildFolderTree, type FolderNode, type VaultPath } from '../../domain/vault/index.ts';
import type { StoredFile } from '../ports/index.ts';

/** What changed in the session; listeners re-read what they show. */
export type VaultChange =
  | { readonly kind: 'loaded' }
  /** A file was created, or its text or sync flags changed. */
  | { readonly kind: 'written'; readonly path: VaultPath }
  | { readonly kind: 'deleted'; readonly path: VaultPath }
  | { readonly kind: 'renamed'; readonly from: VaultPath; readonly to: VaultPath };

export type VaultListener = (change: VaultChange) => void;

/** The index's questions, without its mutators: only the session changes the index. */
export type VaultIndexView = Pick<
  VaultIndex,
  | 'has'
  | 'paths'
  | 'resolve'
  | 'summary'
  | 'outgoing'
  | 'backlinks'
  | 'linkSources'
  | 'unresolved'
  | 'tagsOf'
  | 'notesWithTag'
  | 'tagCounts'
  | 'tagTree'
  | 'graph'
>;

const NO_FAVORITES: ParsedFavorites = { kind: 'ok', favorites: [] };

/**
 * The open vault in memory: every file's text, the derived index, and the
 * favourites, kept in step and announced to listeners. The UI's store
 * subscribes here; nothing here knows about React.
 *
 * Use-cases change it (`apply…`) after the `NoteStore` has the change, so
 * the session never shows what the device has not kept. `version` grows by
 * one with every change, for snapshot-based subscribers.
 */
export class VaultSession {
  private files = new Map<VaultPath, StoredFile>();
  private vaultIndex = new VaultIndex();
  private parsedFavorites: ParsedFavorites = NO_FAVORITES;
  private tree: FolderNode | null = null;
  private readonly listeners = new Set<VaultListener>();
  private changes = 0;

  get version(): number {
    return this.changes;
  }

  get index(): VaultIndexView {
    return this.vaultIndex;
  }

  /** The favourite notes, in order. Empty when the file is missing or malformed. */
  get favorites(): Favorites {
    return this.parsedFavorites.favorites;
  }

  /** Why the favourites file could not be read, or null when it could (or does not exist). */
  get favoritesProblem(): string | null {
    return this.parsedFavorites.kind === 'malformed' ? this.parsedFavorites.reason : null;
  }

  file(path: VaultPath): StoredFile | null {
    return this.files.get(path) ?? null;
  }

  /** Every file held, notes and app files alike, in no set order. */
  allFiles(): IterableIterator<StoredFile> {
    return this.files.values();
  }

  /** The visible notes as a folder tree, rebuilt only when the set of paths changes. */
  folderTree(): FolderNode {
    this.tree ??= buildFolderTree(this.vaultIndex.paths());
    return this.tree;
  }

  subscribe(listener: VaultListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  load(files: Iterable<StoredFile>): void {
    this.files = new Map();
    for (const file of files) this.files.set(file.path, file);
    this.vaultIndex = VaultIndex.build(this.files.values());
    this.parsedFavorites = readFavorites(this.files.get(FAVORITES_PATH));
    this.tree = null;
    this.emit({ kind: 'loaded' });
  }

  applyWrite(file: StoredFile): void {
    const isNew = !this.files.has(file.path);
    this.files.set(file.path, file);
    this.vaultIndex.upsert(file.path, file.text);
    if (file.path === FAVORITES_PATH) this.parsedFavorites = readFavorites(file);
    if (isNew) this.tree = null;
    this.emit({ kind: 'written', path: file.path });
  }

  applyDelete(path: VaultPath): void {
    if (!this.files.delete(path)) return;
    this.vaultIndex.remove(path);
    if (path === FAVORITES_PATH) this.parsedFavorites = NO_FAVORITES;
    this.tree = null;
    this.emit({ kind: 'deleted', path });
  }

  /** `from` is now `to`; `to` carries the file as the store now holds it. */
  applyRename(from: VaultPath, to: StoredFile): void {
    this.files.delete(from);
    this.files.set(to.path, to);
    // `to` may carry new text as well as a new path, so it is read afresh.
    this.vaultIndex.remove(from);
    this.vaultIndex.upsert(to.path, to.text);
    this.tree = null;
    this.emit({ kind: 'renamed', from, to: to.path });
  }

  private emit(change: VaultChange): void {
    this.changes += 1;
    for (const listener of this.listeners) listener(change);
  }
}

function readFavorites(file: StoredFile | undefined): ParsedFavorites {
  return file === undefined ? NO_FAVORITES : parseFavorites(file.text);
}
