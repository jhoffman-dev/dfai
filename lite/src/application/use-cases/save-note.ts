import type { VaultPath } from '../../domain/vault/index.ts';
import { writeFile, type VaultDeps } from './vault-deps.ts';

/**
 * Keeps a note's new text: stored, marked dirty for the next sync, and read
 * into the index (that note only). Text that is already there changes nothing.
 * The caller debounces typing; this is one save.
 */
export async function saveNoteText(
  deps: VaultDeps,
  { path, text }: { path: VaultPath; text: string },
): Promise<void> {
  if (deps.session.file(path)?.text === text) return;
  await writeFile(deps, path, text);
}
