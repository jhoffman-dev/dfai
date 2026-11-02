import {
  CONFLICTS_FOLDER,
  copyOfRefusedWrite,
  createVaultPath,
  joinFrontmatter,
  parentVaultPath,
  type EditorDocument,
  type KeptCopy,
  type VaultPath,
} from '@dfai/domain';
import { ensureFolderOf } from '../sync/ensure-folder.ts';
import { isNoSuchEntry, type VaultFsPort } from '../vault/ports.ts';
import type { MarkdownPort } from './ports.ts';
import type { OpenNote } from './open-note.ts';
import { editedBody } from './save-note.ts';

type Fs = Pick<VaultFsPort, 'listDirectory' | 'createFolder' | 'createNote' | 'readTextFile'>;

/**
 * The second way out of a save refused because the note moved on (#665): the
 * newer version stays in the note, and what the refused save would have
 * written is kept whole as a conflict copy beside it, named for `device` by
 * the desktop's own rule. A note deleted since it was opened is put back at
 * its path with that text instead. Resolves to where the text was kept, or
 * null when the note already holds exactly that text. The file is created,
 * never written over anything: a name taken meanwhile fails it, and the
 * edits are still held.
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
  const newer = await textNow(fs, note.path);
  const first = copyOfRefusedWrite({ path: note.path, device, mine, newer, taken: new Set() });
  if (first === null) return null;
  // Put back where it was, or a setting's copy: a folder that may not be there.
  const putBack = first.path === note.path;
  if (putBack || first.path.startsWith(`${CONFLICTS_FOLDER}/`))
    await ensureFolderOf(fs, first.path);
  const copy = putBack
    ? first
    : await namedBesideWhatIsThere(fs, { first, note, device, mine, newer });
  const path = createVaultPath(copy.path);
  await fs.createNote({ path, contents: copy.contents });
  return path;
}

/** The note's text now, or null when nothing is at its path any more. */
async function textNow(fs: Fs, path: VaultPath): Promise<string | null> {
  try {
    return (await fs.readTextFile(path)).text;
  } catch (error) {
    if (isNoSuchEntry(error)) return null;
    throw error;
  }
}

/** The copy, named past every name in its folder now. */
async function namedBesideWhatIsThere(
  fs: Fs,
  {
    first,
    note,
    device,
    mine,
    newer,
  }: { first: KeptCopy; note: OpenNote; device: string; mine: string; newer: string | null },
): Promise<KeptCopy> {
  const folder = parentVaultPath(createVaultPath(first.path));
  const taken = new Set((await fs.listDirectory(folder)).map((entry) => entry.path));
  // The same two versions as before, so never null: only the name can differ.
  return copyOfRefusedWrite({ path: note.path, device, mine, newer, taken }) ?? first;
}
