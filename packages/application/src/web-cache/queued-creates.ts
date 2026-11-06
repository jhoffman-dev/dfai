import {
  createVaultPath,
  HELD_REFUSAL,
  heldWalk,
  parentVaultPath,
  vaultPathName,
  type QueuedSave,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import { createNoteFileAsWritten } from '../notes/create-note.ts';
import { inVault } from '../vault/in-vault.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import {
  isNameTakenRefusal,
  VaultAccessError,
  VaultUnreachableError,
  type HostVaultFsPort,
  type NoteListing,
  type VaultFsPort,
} from '../vault/ports.ts';

/** Where a queued new note landed: its version, and the path it was numbered to when its own was taken. */
export interface CreateLanded {
  readonly at: number;
  readonly as?: string;
}

/**
 * Sends a new note made offline (#773) as a create, which never lands over
 * a note. Its name taken by then, by its own create whose answer was lost
 * or by another tab's whose hold lapsed, it is that note; by anything else,
 * it is numbered past what is there, as a new note made online is.
 */
export async function sendCreate(fs: HostVaultFsPort, save: QueuedSave): Promise<CreateLanded> {
  const vault = inVault({ fs, vault: save.vault });
  const path = createVaultPath(save.path);
  try {
    return { at: await vault.createNote({ path, contents: save.contents }) };
  } catch (error) {
    if (!isNameTakenRefusal(error)) throw error;
  }
  const already = await versionIfHolding(vault, path, save.contents);
  if (already !== null) return { at: already };
  const numbered = await createNoteFileAsWritten({
    fs: vault,
    name: vaultPathName(path),
    beside: null,
    folder: parentVaultPath(path),
    notePaths: await listVaultNotes({ fs: vault }),
    contents: save.contents,
  });
  return { at: numbered.modified, as: numbered.path };
}

/** The note's version when it holds exactly `contents`; null when it holds anything else. */
async function versionIfHolding(
  vault: VaultFsPort,
  path: VaultPath,
  contents: string,
): Promise<number | null> {
  try {
    const there = await vault.readTextFile(path);
    return there.text === contents ? there.modified : null;
  } catch (error) {
    if (error instanceof VaultUnreachableError) throw error;
    // Not a note it can read (a folder of that name): not this note, so it is numbered past it.
    return null;
  }
}

/**
 * Whether GitHub refused a create for good: its folder is gone. It waits
 * refused, for the person to keep it as a copy — which makes the folder
 * again — or discard it. Any other failure is tried again.
 */
export const isCreateRefusal = (error: unknown): boolean =>
  error instanceof VaultAccessError && error.message === HELD_REFUSAL.noFolder;

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
