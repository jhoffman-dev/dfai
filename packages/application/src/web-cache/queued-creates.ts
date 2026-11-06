import {
  attemptsThatCannotLand,
  createVaultPath,
  HELD_REFUSAL,
  heldWalk,
  isOwnCreate,
  nextAvailableNotePath,
  parentVaultPath,
  vaultPathName,
  type CreateAttempt,
  type FoundNote,
  type QueuedSave,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import { CREATE_ATTEMPTS, NoteNameTakenError } from '../notes/create-note.ts';
import { isStaleWriteRefusal } from '../notes/note-changed-error.ts';
import { inVault } from '../vault/in-vault.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import {
  isNameTakenRefusal,
  isNoSuchEntry,
  VaultAccessError,
  type HostVaultFsPort,
  type NoteContents,
  type NoteListing,
  type VaultFsPort,
} from '../vault/ports.ts';

/** Where a queued new note landed: its version, and the path it was numbered to when its own was taken. */
export interface CreateLanded {
  readonly at: number;
  readonly as?: string;
}

/** What sending a queued new note needs from the queue, which keeps its record. */
export interface CreateSending {
  readonly fs: HostVaultFsPort;
  /** The record as stored when the turn began. */
  readonly save: QueuedSave;
  /** The paths this device's other new notes waiting in the vault hold. */
  readonly held: () => Promise<readonly string[]>;
  /** The mark on the newest change at a path on GitHub, which tells a create of this device's apart. */
  readonly markAt: (path: VaultPath) => Promise<string | null>;
  /** A mark no create has carried before. */
  readonly newMark: () => string;
  /**
   * Records the attempt before it is sent, letting go of `cannotLand`,
   * whose paths a look at GitHub found held by another's note: the record
   * as stored after, or null when another turn changed it.
   */
  readonly remember: (
    attempt: CreateAttempt,
    cannotLand: readonly CreateAttempt[],
  ) => Promise<QueuedSave | null>;
  /** Takes back an attempt GitHub refused as taken, which made nothing there: the record after, or null as `remember`. */
  readonly forget: (attempt: CreateAttempt) => Promise<QueuedSave | null>;
}

/**
 * Sends a new note made offline (#773) as a create, which never lands over
 * a note. Each attempt is recorded before it goes, with a mark its commit
 * carries, so a note found later where one was tried, whose newest change
 * carries that mark, is its own — a lost answer, or a lapsed hold's other
 * turn — and newer typing is saved onto it rather than numbered into a
 * second note. Any other note at its name is someone else's: it is
 * numbered past that, and past this device's own waiting notes. Null:
 * another turn has the record now.
 */
export async function sendCreate(sending: CreateSending): Promise<CreateLanded | null> {
  const vault = inVault({ fs: sending.fs, vault: sending.save.vault });
  let save = sending.save;
  for (let attempt = 1; ; attempt += 1) {
    const { own, found } = await lookForOwn(vault, sending, save);
    if (own !== null) return carriedOn(vault, save, own);
    const untried = attempt === 1 && (save.tried ?? []).length === 0;
    const path = untried ? createVaultPath(save.path) : await freeName(vault, sending, save);
    const tried = { path, text: save.contents, mark: sending.newMark() };
    // Only attempts whose path another's note holds go: one not seen yet may still land.
    const remembered = await sending.remember(tried, attemptsThatCannotLand(save, found));
    if (remembered === null) return null;
    save = remembered;
    try {
      const at = await vault.createNote({ path, contents: save.contents, mark: tried.mark });
      return path === save.path ? { at } : { at, as: path };
    } catch (error) {
      if (!isNameTakenRefusal(error)) throw error;
      const forgotten = await sending.forget(tried);
      if (forgotten === null) return null;
      save = forgotten;
      if (attempt === CREATE_ATTEMPTS) throw new NoteNameTakenError(save.path, { cause: error });
    }
  }
}

/**
 * The note a create tried put there, as it is now (null when none of them
 * is), and the notes found at the paths tried, which tell what cannot land.
 */
async function lookForOwn(
  vault: VaultFsPort,
  sending: CreateSending,
  save: QueuedSave,
): Promise<{ own: (NoteContents & { path: VaultPath }) | null; found: readonly FoundNote[] }> {
  const paths = [...new Set((save.tried ?? []).map((made) => made.path))].reverse();
  const found: FoundNote[] = [];
  for (const at of paths) {
    const path = createVaultPath(at);
    const there = await noteAt(vault, path);
    if (there === null) continue;
    const note = { path, text: there.text, mark: await sending.markAt(path) };
    if (isOwnCreate(save, note)) return { own: { ...there, path }, found };
    found.push(note);
  }
  return { own: null, found };
}

/** Its own note found: newer typing is saved onto it, held to the version a create left there. */
async function carriedOn(
  vault: VaultFsPort,
  save: QueuedSave,
  own: NoteContents & { path: VaultPath },
): Promise<CreateLanded> {
  const as = own.path === save.path ? {} : { as: own.path };
  if (own.text === save.contents) return { at: own.modified, ...as };
  const at = await vault.writeTextFile({
    path: own.path,
    contents: save.contents,
    expectedModified: own.modified,
    expectedText: own.text,
  });
  return { at, ...as };
}

/** The first name free of GitHub's notes and of this device's own waiting ones. */
async function freeName(
  vault: VaultFsPort,
  sending: CreateSending,
  save: QueuedSave,
): Promise<VaultPath> {
  const path = createVaultPath(save.path);
  const taken = [...(await listVaultNotes({ fs: vault })), ...(await sending.held())];
  return nextAvailableNotePath({
    folder: parentVaultPath(path),
    name: vaultPathName(path),
    taken: new Set<string>(taken),
  });
}

/**
 * The note at `path` on GitHub; null only when GitHub says no note is
 * there. Any other failure (the network, GitHub failing) is thrown: a note
 * that could not be read is never taken for none, or a second is made.
 */
export async function noteAt(vault: VaultFsPort, path: VaultPath): Promise<NoteContents | null> {
  try {
    return await vault.readTextFile(path);
  } catch (error) {
    // Nothing there, or a folder of that name: GitHub's answer that no note is at the path.
    if (isNoSuchEntry(error) || isFolderRefusal(error)) return null;
    throw error;
  }
}

const isFolderRefusal = (error: unknown) =>
  error instanceof VaultAccessError && error.message === HELD_REFUSAL.isDirectory;

/**
 * Whether GitHub refused a create for good: its folder is gone, or the note
 * its typing was saved onto moved on since. It waits refused, for the
 * person to keep it as a copy — which makes the folder again — or discard
 * it. Any other failure is tried again.
 */
export const isCreateRefusal = (error: unknown): boolean =>
  (error instanceof VaultAccessError && error.message === HELD_REFUSAL.noFolder) ||
  isStaleWriteRefusal(error);

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

/** The vault's notes as GitHub lists them, with the new notes waiting that the walk reaches and it does not list. */
export function withCreates(
  listed: readonly NoteListing[],
  creates: readonly QueuedSave[],
  walk: Parameters<HostVaultFsPort['listNotes']>[0],
): readonly NoteListing[] {
  const there = new Set<string>(listed.map((note) => note.path));
  const waiting = new Map(creates.filter((save) => !there.has(save.path)).map((s) => [s.path, s]));
  const reached = heldWalk({ files: waiting, folders: new Set() }, walk);
  return [
    ...listed,
    ...reached.map((at) => {
      const save = waiting.get(at)!;
      const path = createVaultPath(at);
      return {
        name: vaultPathName(path),
        path,
        modified: save.provisional,
        size: bytesOf(save.contents),
      };
    }),
  ];
}

/** A folder's entries as GitHub lists them, with the new notes waiting in it that it does not list. */
export function withCreatesIn(
  folder: VaultPath,
  listed: readonly VaultEntry[],
  creates: readonly QueuedSave[],
): readonly VaultEntry[] {
  const there = new Set<string>(listed.map((entry) => entry.path));
  const added = creates
    .map((save) => createVaultPath(save.path))
    .filter((path) => parentVaultPath(path) === folder && !there.has(path))
    .map((path): VaultEntry => ({ kind: 'file', name: vaultPathName(path), path }));
  return [...listed, ...added];
}
