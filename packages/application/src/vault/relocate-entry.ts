import {
  foldedVaultPath,
  moveDestination,
  landingRefusal,
  moveIntoLinkRefusal,
  moveRefusal,
  moveThroughLinkRefusal,
  nameClashes,
  nextAvailableFolderPath,
  nextAvailableNotePath,
  notesUnder,
  parentVaultPath,
  vaultPathName,
  renameRefusal,
  templateEditRefusal,
  unsavedThroughLinkRefusal,
  type EntryMove,
  type MovableEntry,
  type NameClash,
  type VaultPath,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import { forgetNotes } from '../index/refresh-index.ts';
import { withDeclaredType } from './declared-type.ts';
import { linkAbove, linkAtOrAbove } from './listed-links.ts';
import type { OpenEditorsPort, VaultFsPort } from './ports.ts';

/** What a move needs to reach: the files, the index and the open panes. */
export interface RelocationPorts {
  readonly fs: VaultFsPort;
  readonly index: IndexPort;
  readonly editors: OpenEditorsPort;
}

/** A move that happened, and any link it left meaning another note. */
export interface Relocation {
  readonly move: EntryMove;
  readonly clashes: readonly NameClash[];
}

/** Refused before anything is touched: the rule's own words, for the person. */
export class MoveRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoveRefusedError';
  }
}

/**
 * Moves a note or a folder, and everything showing it follows.
 *
 * Panes holding a note under it write their unsaved typing first, so what
 * travels is what is on screen; the file then moves, and each pane is
 * re-pointed at where its note went without reading it again. Typing that
 * lands during the move stays unsaved in the pane and is saved to the new
 * path. The index forgets the old paths straight away — the refresh that
 * follows every change files them under the new ones.
 *
 * A pane may hold a note by way of a link, and the host does not say where a
 * link points, so it may be a note that moves, by another path: it could be
 * neither flushed nor followed as one. Nothing moves while such a pane has
 * unsaved typing (PR #684), looked at before the carried panes are saved and
 * again after, just before the host moves. Only panes with typing are looked
 * into, so a move with none asks the host nothing more. The hold is broad: any
 * pane typing by way of any link holds every move, since the host does not say
 * where a link points and so which links reach what moves.
 */
async function relocate({
  ports,
  entry,
  to,
  notePaths,
}: {
  ports: RelocationPorts;
  entry: MovableEntry;
  to: VaultPath;
  notePaths: readonly VaultPath[];
}): Promise<Relocation> {
  const move = { from: entry.path, to };
  const carried = notesUnder(entry, notePaths);
  await refuseUnsavedThroughLink({ ports, carried, notePaths });

  await ports.editors.flush(carried);
  // Typing may have started by way of a link while the save was on its way.
  await refuseUnsavedThroughLink({ ports, carried, notePaths });
  await ports.fs.moveEntry(move);
  ports.editors.follow(move);
  await forget(ports.index, carried);
  return { move, clashes: nameClashes(move, notePaths) };
}

/** Refuses while a pane not carried by the move has unsaved typing in a note open by way of a link. */
async function refuseUnsavedThroughLink({
  ports,
  carried,
  notePaths,
}: {
  ports: RelocationPorts;
  carried: readonly VaultPath[];
  notePaths: readonly VaultPath[];
}): Promise<void> {
  const moving = new Set(carried);
  const typing = notePaths.filter(
    (path) => !moving.has(path) && ports.editors.state(path) === 'dirty',
  );
  // The note itself may be the link (`Work/alias.md -> ../Shelf/garden.md`).
  const links = await Promise.all(typing.map((path) => linkAtOrAbove(ports.fs, path)));
  const found = typing
    .map((note, at) => ({ note, link: links[at] ?? null }))
    .find(({ link }) => link !== null);
  if (found?.link) throw new MoveRefusedError(unsavedThroughLinkRefusal(found.note, found.link));
}

/**
 * Drops paths that are gone from the index. A failure is safe to let go of:
 * the refresh after every change reconciles the index with the disk, so it
 * only delays the old paths leaving — and the move itself has already landed.
 */
async function forget(index: IndexPort, paths: readonly VaultPath[]): Promise<void> {
  await forgetNotes(index, paths).catch(() => undefined);
}

/**
 * Moves an entry to exactly `to`, a path its caller has already worked out —
 * archiving, which files a note under `Archive/` by rules of its own. The
 * folder `to` is in must already exist. Links on the way are not looked for
 * here, which would list every folder above both paths on each note archived;
 * the host refuses a move through a link before anything moves (#680). The
 * caller has made the folder by then, so such a refusal can leave it empty.
 */
export async function moveEntryTo(args: {
  ports: RelocationPorts;
  entry: MovableEntry;
  to: VaultPath;
  notePaths: readonly VaultPath[];
}): Promise<Relocation> {
  return relocate(args);
}

/**
 * Refuses an entry reached through a link, which the host would move as what
 * the link points at while every pane and link followed the path by the link
 * (#680). The entry itself may be a link: that moves as the link.
 */
async function refuseThroughLink(fs: VaultFsPort, entry: MovableEntry): Promise<void> {
  const link = await linkAbove(fs, entry.path);
  if (link !== null) throw new MoveRefusedError(moveThroughLinkRefusal(link));
}

/** Moves an entry into `folder`, keeping its name. Refused by the domain's rules before anything moves. */
export async function moveEntryInto({
  ports,
  entry,
  folder,
  notePaths,
}: {
  ports: RelocationPorts;
  entry: MovableEntry;
  folder: VaultPath;
  notePaths: readonly VaultPath[];
}): Promise<Relocation> {
  const refusal = moveRefusal(entry, folder);
  if (refusal !== null) throw new MoveRefusedError(refusal);
  const [through, into] = await Promise.all([
    linkAbove(ports.fs, entry.path),
    linkAtOrAbove(ports.fs, folder),
  ]);
  if (through !== null) throw new MoveRefusedError(moveThroughLinkRefusal(through));
  if (into !== null) throw new MoveRefusedError(moveIntoLinkRefusal(into));
  return relocate({ ports, entry, to: moveDestination(entry, folder), notePaths });
}

/**
 * Renames a note or a folder where it is.
 *
 * The name is cleaned and, when taken, numbered — as a new note's is — so a
 * rename cannot fail on a name someone reasonably typed. The entry's own name
 * does not count as taken, so renaming to the same name, or to the same name
 * in another case, is not numbered. Null when there is nothing to do.
 */
export async function renameEntry({
  ports,
  entry,
  name,
  notePaths,
}: {
  ports: RelocationPorts;
  entry: MovableEntry;
  name: string;
  notePaths: readonly VaultPath[];
}): Promise<Relocation | null> {
  const refusal = renameRefusal(await withDeclaredType({ fs: ports.fs, entry }));
  if (refusal !== null) throw new MoveRefusedError(refusal);
  const templateRefusal = templateEditRefusal(entry.path);
  if (templateRefusal !== null) throw new MoveRefusedError(templateRefusal);
  await refuseThroughLink(ports.fs, entry);

  const to = await renamedPath({ fs: ports.fs, entry, name, notePaths });
  if (to === entry.path) return null;
  const landing = landingRefusal(to);
  if (landing !== null) throw new MoveRefusedError(landing);
  return relocate({ ports, entry, to, notePaths });
}

/** Where a rename lands: the cleaned name in the same folder, numbered past what is taken. */
async function renamedPath({
  fs,
  entry,
  name,
  notePaths,
}: {
  fs: VaultFsPort;
  entry: MovableEntry;
  name: string;
  notePaths: readonly VaultPath[];
}): Promise<VaultPath> {
  const folder = parentVaultPath(entry.path);
  const besides = (paths: readonly VaultPath[]) =>
    new Set<string>(
      paths.filter((other) => foldedVaultPath(other) !== foldedVaultPath(entry.path)),
    );

  if (entry.kind === 'file') {
    return nextAvailableNotePath({ folder, name, taken: besides(notePaths) });
  }
  const siblings = (await fs.listDirectory(folder)).map((sibling) => sibling.path);
  const to = nextAvailableFolderPath({ parent: folder, name, taken: besides(siblings) });
  // The same name typed again is no rename, whatever the cleaning made of it.
  return vaultPathName(to) === vaultPathName(entry.path) ? entry.path : to;
}
