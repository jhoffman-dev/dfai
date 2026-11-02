import {
  CONFLICTS_FOLDER,
  copyOfRefusedWrite,
  createVaultPath,
  joinFrontmatter,
  parentVaultPath,
  type EditorDocument,
  type VaultPath,
} from '@dfai/domain';
import { ensureFolderOf } from '../sync/ensure-folder.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import type { MarkdownPort } from './ports.ts';
import type { OpenNote } from './open-note.ts';
import { editedBody } from './save-note.ts';

type Fs = Pick<VaultFsPort, 'listDirectory' | 'createFolder' | 'createNote' | 'readTextFile'>;

/**
 * The second way out of a save refused because the note moved on (#665): the
 * newer version stays in the note, and what the refused save would have
 * written is kept whole as a conflict copy beside it, named for `device` by
 * the desktop's own rule. Resolves to the copy's path, or null when the note
 * already holds exactly that text. The copy is created, never written over
 * anything: a name taken meanwhile fails it, and the edits are still held.
 */
export async function keepRefusedAsCopy({
  fs,
  markdown,
  note,
  doc,
  device,
}: {
  fs: Fs;
  markdown: MarkdownPort;
  note: OpenNote;
  doc: EditorDocument;
  device: string;
}): Promise<VaultPath | null> {
  const mine = joinFrontmatter(note.frontmatter, editedBody({ markdown, note, doc }));
  const newer = (await fs.readTextFile(note.path)).text;
  const first = copyOfRefusedWrite({ path: note.path, device, mine, newer, taken: new Set() });
  if (first === null) return null;
  const folder = parentVaultPath(createVaultPath(first.path));
  // Only a copy of a setting goes to a folder that may not be there yet.
  if (first.path.startsWith(`${CONFLICTS_FOLDER}/`)) await ensureFolderOf(fs, first.path);
  const taken = new Set((await fs.listDirectory(folder)).map((entry) => entry.path));
  // The same two versions as above, so never null: only the name can differ.
  const copy = copyOfRefusedWrite({ path: note.path, device, mine, newer, taken }) ?? first;
  const path = createVaultPath(copy.path);
  await fs.createNote({ path, contents: copy.contents });
  return path;
}
