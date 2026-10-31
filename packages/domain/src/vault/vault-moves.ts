import { resolveWikiLinkTarget } from '../markdown/resolve-wikilink.ts';
import { ATLAS_DIRECTORY } from './vault-visibility.ts';
import { isArchivedPath, isArchiveFolder } from '../archive/archive.ts';
import { isBuiltInTypeFile } from '../types/built-in-types.ts';
import {
  joinVaultPath,
  parentVaultPath,
  vaultPathName,
  VAULT_ROOT,
  type VaultPath,
} from './vault-path.ts';

/** A note or a folder, as far as moving and deleting it is concerned. */
export interface MovableEntry {
  readonly path: VaultPath;
  readonly kind: 'file' | 'directory';
  /** The `name:` a type's file declares, once read; a built-in type's file stays. */
  readonly definesType?: string | null;
}

/** An entry going from one place to another; a folder takes everything under it. */
export interface EntryMove {
  readonly from: VaultPath;
  readonly to: VaultPath;
}

/** Whether `path` is `folder` or somewhere under it. The root holds everything. */
export function isWithin(path: VaultPath, folder: VaultPath): boolean {
  if (folder === VAULT_ROOT) return true;
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * Where `path` is after `move`, or null when the move does not touch it.
 *
 * A folder's move carries every path under it: `Projects/a.md` follows
 * `Projects` to `Archive/Projects/a.md`. A folder whose name only starts the
 * same — `Projects Old` — is not under it.
 */
export function movedPath(path: VaultPath, { from, to }: EntryMove): VaultPath | null {
  if (path === from) return to;
  if (!path.startsWith(`${from}/`)) return null;
  return `${to}${path.slice(from.length)}` as VaultPath;
}

/** Where `path` is after each of `moves` in turn, or null when none touched it. */
export function pathAfterMoves(path: VaultPath, moves: readonly EntryMove[]): VaultPath | null {
  let now: VaultPath | null = null;
  for (const move of moves) now = movedPath(now ?? path, move) ?? now;
  return now;
}

/** Whether a path is DFAI's own folder or anything kept in it. */
function isAtlasPath(path: VaultPath): boolean {
  return isWithin(path, ATLAS_DIRECTORY as VaultPath);
}

/**
 * Why an entry cannot go into `folder`, or null when it can.
 *
 * `.atlas` is DFAI's own: its views, dashboards and templates are listed by
 * where they are, so moving one out would take it from its section, and moving
 * a note in would hide it among the machinery. A folder cannot go inside
 * itself, and a move to where the entry already is would be nothing at all.
 * A name already taken there is not checked here — only the disk knows that
 * for certain, and it refuses rather than overwriting.
 */
export function moveRefusal(entry: MovableEntry, folder: VaultPath): string | null {
  if (isAtlasPath(entry.path)) return 'DFAI keeps its own files where they are.';
  if (isAtlasPath(folder)) return 'Only DFAI keeps files in its own folder.';
  // Into or out of the Archive only by archiving, which records where a note
  // was so it can go back there; a plain move would lose that (U-22).
  if (isArchiveEntry(entry)) return 'Unarchive it to put it back.';
  if (isArchiveEntry({ path: folder, kind: 'directory' })) {
    return 'Archive a note from its menu, so it can go back where it was.';
  }
  if (entry.kind === 'directory' && isWithin(folder, entry.path)) {
    return 'A folder cannot go inside itself.';
  }
  if (parentVaultPath(entry.path) === folder) return 'It is already there.';
  return landingRefusal(moveDestination(entry, folder));
}

/**
 * Why nothing may land at `to`, or null when it may: an entry that became the
 * root `Archive` folder would archive every note in it with nothing recorded
 * to bring them back by — only archiving puts notes there (U-22). Asked of a
 * move's or a rename's destination.
 */
export function landingRefusal(to: VaultPath): string | null {
  return isArchiveFolder({ kind: 'directory', name: vaultPathName(to), path: to })
    ? 'Only archiving puts notes in the Archive — choose another name.'
    : null;
}

/** Whether an entry can be moved anywhere at all — nothing of DFAI's own, nor the Archive's, can. */
export function isMovable(entry: MovableEntry): boolean {
  return !isAtlasPath(entry.path) && !isArchiveEntry(entry);
}

/** The Archive folder, or anything in it. */
function isArchiveEntry(entry: MovableEntry): boolean {
  return (
    isArchivedPath(entry.path) || isArchiveFolder({ ...entry, name: vaultPathName(entry.path) })
  );
}

/** Why a folder cannot be made in `parent`, or null when it can: only DFAI makes folders in `.atlas`. */
export function newFolderRefusal(parent: VaultPath): string | null {
  return isAtlasPath(parent) ? 'Only DFAI keeps folders in its own folder.' : null;
}

/** Where an entry lands when it is moved into `folder`, keeping its name. */
export function moveDestination(entry: MovableEntry, folder: VaultPath): VaultPath {
  return joinVaultPath(folder, vaultPathName(entry.path));
}

/**
 * Why the file of a built-in type — Person, Task, Project, Artifact — stays
 * where it is under its name: features depend on the type (U-20). A rename
 * would not change the type, but it would carry the file past this rule.
 */
const BUILT_IN_TYPE = 'DFAI’s built-in types stay — its features depend on them.';

/**
 * Why an entry cannot go to the Trash, or null when it can.
 *
 * `.atlas` and the folders in it are DFAI's structure — without them there
 * are no types, views or templates. What they hold — a view, a dashboard, a
 * template, a type of your own — can go, as any note can; a built-in type
 * cannot.
 */
export function deleteRefusal(entry: MovableEntry): string | null {
  if (isAtlasStructure(entry)) return 'DFAI needs its own folders.';
  if (isBuiltInTypeFile(entry.path, entry.definesType ?? null)) return BUILT_IN_TYPE;
  // Every archived note at once is too much to lose to one slip; delete them from the Archive.
  if (isArchiveFolder({ ...entry, name: vaultPathName(entry.path) })) {
    return 'Delete notes from the Archive instead.';
  }
  return null;
}

/**
 * Why an entry reached through `link`, a folder above it that is a symlink,
 * is not deleted: the Trash would take what the link points at, and where
 * that is — so which notes, and whose unsaved typing, would go — cannot be
 * told from the link's side (#169).
 */
export function deleteThroughLinkRefusal(link: VaultPath): string {
  return (
    `It is inside “${link}”, which is a link: deleting it here would delete what the link ` +
    'points at. Delete it where it really is, or delete the link.'
  );
}

/**
 * Why an entry reached through `link`, a folder above it that is a symlink,
 * is not moved or renamed: the host would move what the link points at, while
 * its panes and the links naming it were moved for the path by the link (#680).
 */
export function moveThroughLinkRefusal(link: VaultPath): string {
  return (
    `It is inside “${link}”, which is a link: moving or renaming it here would move what ` +
    'the link points at. Do it where it really is, or move the link.'
  );
}

/**
 * Why nothing is moved into `link`, or into a folder reached through it: it
 * would land where the link points, a path the app cannot tell (#680).
 */
export function moveIntoLinkRefusal(link: VaultPath): string {
  return (
    `“${link}” is a link: moving into it would put it where the link points. ` +
    'Move it into that folder itself.'
  );
}

/**
 * Why a move is refused that would point `link`, which it carries, at
 * something else: a relative link is read from where it is (PR #684).
 */
export function moveRepointsLinkRefusal(link: VaultPath): string {
  return (
    `Moving it would point the link “${link}” at something else: a link is read from ` +
    'where it is. Move it where the link still reaches the same place.'
  );
}

/**
 * Why nothing moves while `note`, open by way of `link`, holds unsaved typing:
 * where the link points cannot be told, so it may be what is moving, and its
 * pane could not be followed there (PR #684).
 */
export function unsavedThroughLinkRefusal(note: VaultPath, link: VaultPath): string {
  return (
    `“${note}” has typing not yet saved, and it is open by way of the link “${link}”, ` +
    'which may point into what is moving. Wait for it to save, then try again.'
  );
}

/** How many links a deletion question names before saying how many more. */
const LINKS_NAMED = 5;

/**
 * What a deletion question says of the links a folder holds: the Trash takes
 * each as a link, and what it points at stays. Empty when there are none.
 */
export function linksGoAsLinks(names: readonly string[]): string {
  if (names.length === 0) return '';
  const rest = names.length - LINKS_NAMED;
  const shown = names.slice(0, LINKS_NAMED).join(', ') + (rest > 0 ? ` and ${rest} more` : '');
  return names.length === 1
    ? `The link in it, ${shown}, goes as a link: what it points at stays where it is.`
    : `The ${names.length} links in it, ${shown}, go as links: what they point at stays where it is.`;
}

/**
 * Why an entry cannot be renamed where it is, or null when it can.
 *
 * Renaming keeps an entry in its folder, so a view or a dashboard can be
 * renamed inside `.atlas`; the folders that make up `.atlas` keep their names,
 * since each section finds what it lists by them.
 */
export function renameRefusal(entry: MovableEntry): string | null {
  if (isAtlasStructure(entry)) return 'DFAI needs its own folders.';
  if (isBuiltInTypeFile(entry.path, entry.definesType ?? null)) return BUILT_IN_TYPE;
  return isArchiveEntry(entry) ? 'Unarchive it to rename it.' : null;
}

/** `.atlas`, or a folder inside it. */
function isAtlasStructure(entry: MovableEntry): boolean {
  return entry.kind === 'directory' && isAtlasPath(entry.path);
}

/**
 * The notes `entry` stands for: itself, or every note in `notePaths` under the
 * folder. A note stands for itself even when `notePaths` leaves it out, as it
 * does a view or a dashboard, which their own sections list.
 */
export function notesUnder(entry: MovableEntry, notePaths: readonly VaultPath[]): VaultPath[] {
  if (entry.kind === 'file') return [entry.path];
  return notePaths.filter((path) => isWithin(path, entry.path) && path !== entry.path);
}

const MARKDOWN = /\.(md|markdown)$/i;
const linkName = (path: VaultPath): string => vaultPathName(path).replace(MARKDOWN, '');
const sameName = (left: VaultPath, right: VaultPath): boolean =>
  linkName(left).toLowerCase() === linkName(right).toLowerCase();

/** A name more than one note answers to after a move, and the note `[[name]]` now opens. */
export interface NameClash {
  readonly name: string;
  readonly opens: VaultPath;
}

/**
 * The names a move leaves ambiguous in a way that matters.
 *
 * `[[Name]]` is resolved by name, the shallowest match winning, so moving a
 * note keeps its links working — unless another note shares the name. A move
 * is reported when it makes a name shared that was not (a rename onto a name
 * used elsewhere), or changes which of the namesakes a link opens (a move to
 * another depth). The move is still made — it is the person's vault — but they
 * are told where `[[name]]` goes now.
 */
export function nameClashes(move: EntryMove, notePaths: readonly VaultPath[]): NameClash[] {
  const after = notePaths.map((path) => movedPath(path, move) ?? path);
  const movedNotes = notePaths.flatMap((path) => movedPath(path, move) ?? []);
  const names = [...new Set(movedNotes.map(linkName))];

  return names.flatMap((name) => {
    const probe = `${name}.md` as VaultPath;
    const sharedBefore = notePaths.filter((path) => sameName(path, probe)).length;
    const sharedAfter = after.filter((path) => sameName(path, probe)).length;
    if (sharedAfter < 2) return [];
    const before = resolveWikiLinkTarget(name, notePaths);
    const opens = resolveWikiLinkTarget(name, after);
    const redirected = (before === null ? null : (movedPath(before, move) ?? before)) !== opens;
    return opens !== null && (sharedAfter > sharedBefore || redirected) ? [{ name, opens }] : [];
  });
}

/**
 * The folders an entry can be moved into, the vault's top level first.
 *
 * `folders` is every folder in the vault; the ones a move would be refused
 * into — itself, under itself, where it already is, DFAI's own — are left out
 * rather than offered and then refused.
 */
export function moveTargets(entry: MovableEntry, folders: readonly VaultPath[]): VaultPath[] {
  return [VAULT_ROOT, ...folders].filter((folder) => moveRefusal(entry, folder) === null);
}
