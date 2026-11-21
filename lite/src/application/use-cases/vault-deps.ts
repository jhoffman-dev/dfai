import type { VaultPath } from '../../domain/vault/index.ts';
import type { NoteStore, StoredFile } from '../ports/index.ts';
import type { VaultSession } from '../session/index.ts';

/** What every vault use-case needs: where files are kept, and the open session. */
export interface VaultDeps {
  readonly store: NoteStore;
  readonly session: VaultSession;
}

/**
 * Keeps `text` at `path` as an edit made on this device: stored first, then
 * shown. The base sha it was in step with is kept, so sync can tell an edit
 * from a new file. Returns the file as stored.
 */
export async function writeFile(
  { store, session }: VaultDeps,
  path: VaultPath,
  text: string,
): Promise<StoredFile> {
  const file: StoredFile = {
    path,
    text,
    baseSha: session.file(path)?.baseSha ?? null,
    dirty: true,
  };
  await store.put(file);
  session.applyWrite(file);
  return file;
}
