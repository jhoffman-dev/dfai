import { noteFromLink, type NoteFromLink } from '../../domain/links/index.ts';
import { INBOX_FOLDER, uniqueNotePath, type VaultPath } from '../../domain/vault/index.ts';
import { writeFile, type VaultDeps } from './vault-deps.ts';

/**
 * A new note named `Untitled` (numbered past any taken), in `Inbox/` unless
 * another folder is given. Returns its path.
 */
export async function createQuickNote(
  deps: VaultDeps,
  { text = '', folder = INBOX_FOLDER }: { text?: string; folder?: VaultPath } = {},
): Promise<VaultPath> {
  const taken = [...deps.session.allFiles()].map((file) => file.path);
  const path = uniqueNotePath({ folder, taken });
  await writeFile(deps, path, text);
  return path;
}

/**
 * Follows a link to a note that may not exist: opens the one that answers,
 * or makes it (empty) where `noteFromLink` says. A refusal makes nothing.
 */
export async function createNoteFromLink(
  deps: VaultDeps,
  { target }: { target: string },
): Promise<NoteFromLink> {
  const index = deps.session.index;
  const result = noteFromLink(target, (typed) => index.resolve(typed));
  if (result.kind === 'create') await writeFile(deps, result.path, '');
  return result;
}
