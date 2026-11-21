import type { VaultPath } from '../../domain/vault/index.ts';
import type { NoteStore, StoredFile } from '../ports/index.ts';

/**
 * A `NoteStore` held in memory: the tests' store, and the app's when it runs
 * on the sample vault with no repository connected. Keeps copies, so a
 * caller changing an object it passed in cannot change what is stored.
 */
export class MemoryNoteStore implements NoteStore {
  private readonly files = new Map<VaultPath, StoredFile>();
  private readonly state = new Map<string, string>();

  constructor(files: Iterable<StoredFile> = []) {
    for (const file of files) this.files.set(file.path, { ...file });
  }

  /** A store of synced, clean files: `{ path: text }`. */
  static of(texts: Readonly<Record<VaultPath, string>>): MemoryNoteStore {
    return new MemoryNoteStore(
      Object.entries(texts).map(([path, text]) => ({ path, text, baseSha: null, dirty: false })),
    );
  }

  async list(): Promise<StoredFile[]> {
    return [...this.files.values()]
      .map((file) => ({ ...file }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }

  async get(path: VaultPath): Promise<StoredFile | null> {
    const file = this.files.get(path);
    return file === undefined ? null : { ...file };
  }

  async put(file: StoredFile): Promise<void> {
    this.files.set(file.path, { ...file });
  }

  async delete(path: VaultPath): Promise<void> {
    this.files.delete(path);
  }

  async rename(from: VaultPath, to: StoredFile): Promise<void> {
    this.files.delete(from);
    this.files.set(to.path, { ...to });
  }

  async getState(key: string): Promise<string | null> {
    return this.state.get(key) ?? null;
  }

  async setState(key: string, value: string): Promise<void> {
    this.state.set(key, value);
  }
}
