import {
  deleteRefusal,
  deleteThroughLinkRefusal,
  notesUnder,
  parentVaultPath,
  VAULT_ROOT,
  vaultPathName,
  type MovableEntry,
  type VaultPath,
} from '@dfai/domain';
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
 * How deep a folder is walked for the count. Links are not walked into, but a
 * host that does not mark them lists a link to a folder as a folder, and a
 * link back up would otherwise be walked for ever.
 */
const DEEPEST = 32;

/** What else deleting a folder takes, as its listing shows it. */
export interface OtherFilesCount {
  /** Whether the folder is itself a link: then only the link goes, and nothing in it is counted. */
  readonly link: boolean;
  /** How many files it holds besides its notes. */
  readonly count: number;
  /** The links it holds, which go as links: what they point at stays (#169). */
  readonly links: readonly VaultPath[];
  /** The link above it that it is reached through, or null: then it is not deleted from here. */
  readonly reachedThrough: VaultPath | null;
}

/**
 * How many files deleting `entry` takes besides its notes — images, PDFs,
 * anything the index does not hold — so the question can say what really goes.
 * The Trash takes a link as a link, so a link is named, never walked into.
 */
export async function countOtherFiles({
  fs,
  entry,
  notes,
}: {
  fs: Pick<VaultFsPort, 'listDirectory'>;
  entry: MovableEntry;
  notes: readonly VaultPath[];
}): Promise<OtherFilesCount> {
  const nothing = { link: false, count: 0, links: [], reachedThrough: null };
  if (entry.kind !== 'directory') return nothing;
  const reachedThrough = await linkAbove(fs, entry.path);
  if (reachedThrough !== null) return { ...nothing, reachedThrough };
  if (await isListedAsLink(fs, entry.path)) return { ...nothing, link: true };
  const known = new Set<string>(notes);
  const { files, links } = await filesAndLinksUnder({ fs, folder: entry.path });
  return { ...nothing, count: files.filter((path) => !known.has(path)).length, links };
}

/** The nearest folder above `path` that is a link, or null when none is. */
export async function linkAbove(
  fs: Pick<VaultFsPort, 'listDirectory'>,
  path: VaultPath,
): Promise<VaultPath | null> {
  const above: VaultPath[] = [];
  for (let at = parentVaultPath(path); at !== VAULT_ROOT; at = parentVaultPath(at)) above.push(at);
  const linked = await Promise.all(above.map((folder) => isListedAsLink(fs, folder)));
  return above.find((_, at) => linked[at]) ?? null;
}

/** Whether the folder above lists `path` as a link. */
export async function isListedAsLink(
  fs: Pick<VaultFsPort, 'listDirectory'>,
  path: VaultPath,
): Promise<boolean> {
  const name = vaultPathName(path);
  const entries = await fs.listDirectory(parentVaultPath(path));
  return entries.some((entry) => entry.name === name && entry.link === true);
}

/**
 * The files in `folder` and the folders inside it, as deep as {@link DEEPEST},
 * and apart from them the links, which a Trash takes as links: neither walked
 * into nor counted as what they point at (#169). Only as the host says, which
 * links it marks.
 */
export async function filesAndLinksUnder({
  fs,
  folder,
}: {
  fs: Pick<VaultFsPort, 'listDirectory'>;
  folder: VaultPath;
}): Promise<{ files: VaultPath[]; links: VaultPath[] }> {
  const files: VaultPath[] = [];
  const links: VaultPath[] = [];
  let level: VaultPath[] = [folder];
  for (let depth = 0; depth < DEEPEST && level.length > 0; depth += 1) {
    const listings = await Promise.all(level.map((each) => fs.listDirectory(each)));
    const listed = listings.flat();
    links.push(...listed.filter((item) => item.link === true).map((item) => item.path));
    const own = listed.filter((item) => item.link !== true);
    files.push(...own.filter((item) => item.kind === 'file').map((item) => item.path));
    level = own.filter((item) => item.kind === 'directory').map((item) => item.path);
  }
  return { files, links };
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
  const link = await linkAbove(fs, entry.path);
  if (link !== null) throw new MoveRefusedError(deleteThroughLinkRefusal(link));

  const gone = notesUnder(entry, notePaths);
  await fs.trashEntry({ path: entry.path });
  editors.abandon(gone);
  // Safe to let go of: the refresh after every change removes what is no
  // longer on disk, and re-resolves what named it, so a failure only delays it.
  await forgetNotes(index, gone).catch(() => undefined);
  return gone;
}
