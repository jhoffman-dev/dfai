import { deleteRefusal, notesUnder, type MovableEntry, type VaultPath } from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import { forgetNotes } from '../index/refresh-index.ts';
import { withDeclaredType } from './declared-type.ts';
import { MoveRefusedError } from './relocate-entry.ts';
import type { OpenEditorsPort, VaultFsPort } from './ports.ts';

/** What deleting an entry would take with it, for the question asked first. */
export interface DeletionPreview {
  /** Every note that goes: the note itself, or all of a folder's. */
  readonly notes: readonly VaultPath[];
  /** The ones open in a pane with typing not yet saved, which would be lost. */
  readonly unsaved: readonly VaultPath[];
  /** Why it cannot be deleted at all, or null. */
  readonly refusal: string | null;
}

/** What is at stake in deleting `entry` — asked before anything is touched. */
export function previewDeletion({
  entry,
  notePaths,
  editors,
}: {
  entry: MovableEntry;
  notePaths: readonly VaultPath[];
  editors: Pick<OpenEditorsPort, 'state'>;
}): DeletionPreview {
  const notes = notesUnder(entry, notePaths);
  return {
    notes,
    unsaved: notes.filter((path) => editors.state(path) === 'dirty'),
    refusal: deleteRefusal(entry),
  };
}

/**
 * How deep a folder is walked for the count. A link to a folder lists as a
 * folder, and a link back up would otherwise be walked for ever.
 */
const DEEPEST = 32;

/**
 * How many files deleting `entry` takes besides its notes — images, PDFs,
 * anything the index does not hold — so the question can say what really goes.
 */
export async function countOtherFiles({
  fs,
  entry,
  notes,
}: {
  fs: Pick<VaultFsPort, 'listDirectory'>;
  entry: MovableEntry;
  notes: readonly VaultPath[];
}): Promise<number> {
  if (entry.kind !== 'directory') return 0;
  const known = new Set<string>(notes);
  const files = await filesUnder({ fs, folder: entry.path });
  return files.filter((path) => !known.has(path)).length;
}

/** Every file in `folder` and the folders inside it, as deep as {@link DEEPEST}. */
export async function filesUnder({
  fs,
  folder,
}: {
  fs: Pick<VaultFsPort, 'listDirectory'>;
  folder: VaultPath;
}): Promise<VaultPath[]> {
  const files: VaultPath[] = [];
  let level: VaultPath[] = [folder];
  for (let depth = 0; depth < DEEPEST && level.length > 0; depth += 1) {
    const listings = await Promise.all(level.map((each) => fs.listDirectory(each)));
    const entries = listings.flat();
    files.push(...entries.filter((item) => item.kind === 'file').map((item) => item.path));
    level = entries.filter((item) => item.kind === 'directory').map((item) => item.path);
  }
  return files;
}

/**
 * Puts a note or a folder in the Trash, and lets go of everything showing it.
 *
 * The Trash comes first: if it refuses, nothing else has happened and the
 * unsaved typing of any pane on the note is still there. Only once the file is
 * gone are the panes told to drop their edits — the person was asked, and a
 * save on the way out would otherwise try to write a note that no longer
 * exists. Answers with the notes that went, for closing their panes.
 */
export async function deleteEntry({
  fs,
  index,
  editors,
  entry,
  notePaths,
}: {
  fs: VaultFsPort;
  index: IndexPort;
  editors: OpenEditorsPort;
  entry: MovableEntry;
  notePaths: readonly VaultPath[];
}): Promise<readonly VaultPath[]> {
  const refusal = deleteRefusal(await withDeclaredType({ fs, entry }));
  if (refusal !== null) throw new MoveRefusedError(refusal);

  const gone = notesUnder(entry, notePaths);
  await fs.trashEntry({ path: entry.path });
  editors.abandon(gone);
  // Safe to let go of: the refresh after every change removes what is no
  // longer on disk, and re-resolves what named it, so a failure only delays it.
  await forgetNotes(index, gone).catch(() => undefined);
  return gone;
}
