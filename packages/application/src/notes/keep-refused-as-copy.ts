import {
  copyOfRefusedWrite,
  createVaultPath,
  joinFrontmatter,
  parentVaultPath,
  type EditorDocument,
  type VaultEntry,
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
  return keepTextAsCopy({ fs, path: note.path, mine, device });
}

/**
 * `mine`, a refused write's whole text, kept beside the note at `path` by
 * the same rule: the way out for a save that waited offline and was refused
 * once sent (#667), which has the text and no editor.
 */
export async function keepTextAsCopy({
  fs,
  path,
  mine,
  device,
}: {
  fs: Fs;
  path: VaultPath;
  mine: string;
  device: string;
}): Promise<VaultPath | null> {
  const folder = parentVaultPath(path);
  const beside = await entriesIn(fs, folder);
  // Only a note still at its path has a newer version; a folder or a twin
  // there now is something else, which the rule keeps the copy beside.
  const noteThere = beside.some((entry) => entry.kind === 'file' && entry.path === path);
  const newer = noteThere ? await textNow(fs, path) : null;
  const versions = { path, device, mine, newer };
  const first = copyOfRefusedWrite({ ...versions, taken: pathsOf(beside) });
  if (first === null) return null;
  const copyFolder = parentVaultPath(createVaultPath(first.path));
  // Put back where it was, or a setting's copy: a folder that may not be there.
  if (first.path === path || copyFolder !== folder) await ensureFolderOf(fs, first.path);
  const copy =
    copyFolder === folder
      ? first
      : // A setting's copy goes to its own folder, named past what is there.
        (copyOfRefusedWrite({ ...versions, taken: pathsOf(await entriesIn(fs, copyFolder)) }) ??
        first);
  const kept = createVaultPath(copy.path);
  await fs.createNote({ path: kept, contents: copy.contents });
  return kept;
}

const pathsOf = (entries: readonly VaultEntry[]): ReadonlySet<string> =>
  new Set(entries.map((entry) => entry.path));

/** What a folder holds now; nothing, when the folder itself is gone. */
async function entriesIn(fs: Fs, folder: VaultPath): Promise<readonly VaultEntry[]> {
  try {
    return await fs.listDirectory(folder);
  } catch (error) {
    if (isNoSuchEntry(error)) return [];
    throw error;
  }
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
