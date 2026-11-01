import {
  createVaultPath,
  HELD_REFUSAL,
  heldBinaryWrite,
  heldChildren,
  heldFileRefusal,
  heldFilesWithExtension,
  heldMove,
  heldPathRefusal,
  heldPlaceRefusal,
  heldWalk,
  isHeld,
  isHeldNote,
  vaultPathName,
  type HeldVault,
  type Refused,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import {
  EntryChangedError,
  HOST_CHANGED_ON_DISK,
  VaultAccessError,
  type AsRead,
  type HostVaultFsPort,
  type NoteFile,
} from '@dfai/application';
import { gitBlobSha, textOfBytes, utf8, versionOfBlob } from './git-bytes.ts';
import type { GitBranch, TreeChange } from './git-branch.ts';
import type { GitTreeEntry } from './github-answers.ts';

/**
 * The vault as a GitHub repository's branch (#664): `HostVaultFsPort` over
 * the Git Data API. Reads come from the branch head's tree and its blobs;
 * every save, create, move and trash is one commit on the head it was
 * checked against, and the branch moves only as a fast-forward of it.
 *
 * The rules are the host's, from the domain (`held-vault.ts`), so this
 * vault and the session vault answer the contract alike. What is GitHub's
 * own is translated here:
 *
 * - **A note's version is its blob** (`versionOfBlob`), where the desktop
 *   has a modification time. A save names the blob it expects to replace,
 *   by that version and, given `expectedText`, by git's name for that text;
 *   one that has moved is refused with {@link HOST_CHANGED_ON_DISK}, as the
 *   host refuses it, and a trash with {@link EntryChangedError}. So is a
 *   write whose branch moved between its check and its commit (#665 offers
 *   the conflict copy).
 * - **Byte-preserving** (ADR-0003): a save of the bytes already there makes
 *   no commit, a move carries each blob unread, and a blob read back is
 *   checked to be the blob named.
 * - **Git has no empty folders**: a folder made here holds a `.gitkeep`,
 *   which is never listed; a move or a trash of the folder takes it along.
 * - **GitHub's trees are case-sensitive and the Mac's disk is not**: the
 *   domain's rule refuses a name that only differs in case from one there.
 * - Writes go one at a time, so two of this page's own never race each other.
 */

/** The placeholder that makes a folder made here a folder in git. */
export const FOLDER_PLACEHOLDER = '.gitkeep';
const FILE_MODE = '100644';
const CHANGED_TRASH = 'a file changed on disk since it was read, so nothing was moved to the Trash';

interface GitFile {
  readonly sha: string;
  readonly size: number;
  readonly mode: string;
}

/** The branch at one commit: the vault's files and folders, and every blob git holds for them. */
interface Snapshot extends HeldVault<GitFile> {
  readonly head: string;
  readonly tree: string;
  /** Every blob, placeholders included: what a move or a trash takes along. */
  readonly blobs: ReadonlyMap<string, GitFile>;
}

const refuse = (message: string): never => {
  throw new VaultAccessError(message);
};
const refuseIf = (refusal: string | null) => {
  if (refusal !== null) refuse(refusal);
};
function unlessRefused<T extends object>(answer: Refused | T): T {
  if ('refused' in answer) return refuse(answer.refused);
  return answer;
}
const changedOnDisk = () => new VaultAccessError(HOST_CHANGED_ON_DISK);
const changedTrash = () => new EntryChangedError(CHANGED_TRASH);
const isPlaceholder = (path: string) => path.split('/').at(-1) === FOLDER_PLACEHOLDER;
const within = (path: string, entry: string) =>
  entry === '' || path === entry || path.startsWith(`${entry}/`);

function snapshotOf(head: string, tree: string, entries: readonly GitTreeEntry[]): Snapshot {
  const files = new Map<string, GitFile>();
  const folders = new Set<string>();
  const blobs = new Map<string, GitFile>();
  for (const entry of entries) {
    if (entry.type === 'tree') folders.add(entry.path);
    // A submodule is another repository, not part of this vault.
    if (entry.type !== 'blob') continue;
    const file = { sha: entry.sha, size: entry.size ?? 0, mode: entry.mode };
    blobs.set(entry.path, file);
    if (!isPlaceholder(entry.path)) files.set(entry.path, file);
  }
  return { head, tree, files, folders, blobs };
}

export interface GitHubVaultFsDeps {
  readonly branch: GitBranch;
  /** The key every write names, refused for any other (R14-01). */
  readonly vault: string;
}

export function gitHubVaultFs({ branch, vault }: GitHubVaultFsDeps): HostVaultFsPort {
  const at = branchAt(branch);
  const writes = writing({ branch, at });
  let queue: Promise<unknown> = Promise.resolve();
  const forTheOpenVault =
    <Args, Result>(write: (args: Args) => Promise<Result>) =>
    (args: Args & { vault: string }): Promise<Result> => {
      if (args.vault !== vault) return Promise.reject(notOpen(args.vault));
      const run = queue.then(() => write(args));
      // The next write waits for this one to settle, whichever way it went.
      queue = run.catch(() => undefined);
      return run;
    };
  return {
    ...reads({ branch, at }),
    createNote: forTheOpenVault(writes.createNote),
    createFolder: forTheOpenVault(writes.createFolder),
    moveEntry: forTheOpenVault(writes.moveEntry),
    trashEntry: forTheOpenVault(writes.trashEntry),
    writeTextFile: forTheOpenVault(writes.writeTextFile),
    writeBinaryFile: forTheOpenVault(writes.writeBinaryFile),
  };
}

const notOpen = (named: string) => new VaultAccessError(`${named} is not the open vault`);

/** The branch as it is now: its head asked for every time, its tree read again only when that moved. */
function branchAt(branch: GitBranch): () => Promise<Snapshot> {
  let last: Snapshot | null = null;
  return async () => {
    const head = await branch.head();
    if (last?.head === head) return last;
    const listing = await branch.listing(head);
    last = snapshotOf(head, listing.sha, listing.entries);
    return last;
  };
}

interface Through {
  readonly branch: GitBranch;
  readonly at: () => Promise<Snapshot>;
}

const directory = (path: string): VaultEntry => ({
  kind: 'directory',
  name: vaultPathName(createVaultPath(path)),
  path: createVaultPath(path),
});
const fileEntry = (path: string, file: GitFile): VaultEntry => ({
  kind: 'file',
  name: vaultPathName(createVaultPath(path)),
  path: createVaultPath(path),
  modified: versionOfBlob(file.sha),
  size: file.size,
});

function reads({ branch, at }: Through) {
  /** The text of a file in this snapshot, or null when its bytes are not UTF-8. */
  const textAt = async (snapshot: Snapshot, path: string) => {
    const file = snapshot.files.get(path)!;
    const text = textOfBytes(await branch.blob(file.sha));
    return text === null ? null : { text, modified: versionOfBlob(file.sha), size: file.size };
  };
  const fileAt = async (path: string) => {
    refuseIf(heldPathRefusal(path));
    const snapshot = await at();
    refuseIf(heldFileRefusal(snapshot, path));
    return snapshot;
  };
  return {
    listDirectory: async (folder: VaultPath) => {
      refuseIf(heldPathRefusal(folder));
      const snapshot = await at();
      return unlessRefused(heldChildren(snapshot, folder)).children.map(({ kind, path }) =>
        kind === 'file' ? fileEntry(path, snapshot.files.get(path)!) : directory(path),
      );
    },
    listNotes: async (walk: { skipDirectories: readonly string[]; maxDepth: number }) => {
      const snapshot = await at();
      return heldWalk(snapshot, walk)
        .filter(isHeldNote)
        .map((path) => {
          const file = snapshot.files.get(path)!;
          const notePath = createVaultPath(path);
          const name = vaultPathName(notePath);
          return { name, path: notePath, modified: versionOfBlob(file.sha), size: file.size };
        });
    },
    listFiles: async (walk: Parameters<HostVaultFsPort['listFiles']>[0]) =>
      heldFilesWithExtension(await at(), walk).map(createVaultPath),
    /** A note gone or not text is left out, as the host leaves it out. */
    readNotes: async (paths: readonly string[]): Promise<NoteFile[]> => {
      const snapshot = await at();
      const present = paths.filter((path) => snapshot.files.has(path));
      const read = await Promise.all(
        present.map(async (path) => {
          const note = await textAt(snapshot, path);
          return note === null ? [] : [{ path, ...note }];
        }),
      );
      return read.flat();
    },
    readTextFile: async (path: VaultPath) => {
      const note = await textAt(await fileAt(path), path);
      if (note === null) return refuse('not a text file');
      return { text: note.text, modified: note.modified };
    },
    readBinaryFile: async (path: VaultPath) => {
      const snapshot = await fileAt(path);
      return (await branch.blob(snapshot.files.get(path)!.sha)).slice().buffer;
    },
  };
}

type TextWrite = Parameters<HostVaultFsPort['writeTextFile']>[0];
type BinaryWrite = Parameters<HostVaultFsPort['writeBinaryFile']>[0];
type Move = Parameters<HostVaultFsPort['moveEntry']>[0];
type Trash = Parameters<HostVaultFsPort['trashEntry']>[0];

const put = (path: string, sha: string, mode = FILE_MODE): TreeChange => ({
  path,
  mode,
  type: 'blob',
  sha,
});
const takeAway = (path: string, mode: string): TreeChange => ({
  path,
  mode,
  type: 'blob',
  sha: null,
});

function writing({ branch, at }: Through) {
  const commitOn = (
    snapshot: Snapshot,
    {
      changes,
      message,
      moved = changedOnDisk,
    }: { changes: TreeChange[]; message: string; moved?: () => Error },
  ) => branch.commit({ head: snapshot.head, tree: snapshot.tree, changes, message, moved });

  /** A new file of these bytes where nothing is, in a folder that is there. */
  const create: Create = async (snapshot, { path, bytes, taken }) => {
    refuseIf(heldPlaceRefusal(snapshot, { path, taken }));
    const sha = await branch.upload(bytes);
    await commitOn(snapshot, { changes: [put(path, sha)], message: `Create ${path}` });
    return sha;
  };

  return {
    createNote: async ({ path, contents }: { path: VaultPath; contents: string }) =>
      versionOfBlob(
        await create(await at(), { path, bytes: utf8(contents), taken: HELD_REFUSAL.noteTaken }),
      ),
    createFolder: async ({ path }: { path: VaultPath }) => {
      const snapshot = await at();
      refuseIf(heldPlaceRefusal(snapshot, { path, taken: HELD_REFUSAL.nameTaken }));
      const sha = await branch.upload(new Uint8Array());
      await commitOn(snapshot, {
        changes: [put(`${path}/${FOLDER_PLACEHOLDER}`, sha)],
        message: `Create folder ${path}`,
      });
    },
    writeTextFile: (args: TextWrite) => saveText({ at, branch, commitOn }, args),
    moveEntry: async ({ from, to }: Move) => {
      const snapshot = await at();
      const { renames } = unlessRefused(heldMove(snapshot, { from, to }));
      if (renames.length === 0) return;
      const carried = [...snapshot.blobs].filter(([path]) => within(path, from));
      const changes = carried.flatMap(([path, file]) => [
        takeAway(path, file.mode),
        put(`${to}${path.slice(from.length)}`, file.sha, file.mode),
      ]);
      await commitOn(snapshot, { changes, message: `Move ${from} to ${to}` });
    },
    trashEntry: async ({ path, unchanged = [] }: Trash) => {
      refuseIf(heldPathRefusal(path));
      const snapshot = await at();
      if (!isHeld(snapshot, path)) refuse(HELD_REFUSAL.noEntry);
      for (const file of unchanged) if (!(await isAsRead(snapshot, file))) throw changedTrash();
      const changes = [...snapshot.blobs]
        .filter(([blob]) => within(blob, path))
        .map(([blob, file]) => takeAway(blob, file.mode));
      await commitOn(snapshot, { changes, message: `Trash ${path}`, moved: changedTrash });
    },
    writeBinaryFile: (args: BinaryWrite) => writeBytes({ at, branch, commitOn, create }, args),
  };
}

type Create = (
  snapshot: Snapshot,
  asked: { path: string; bytes: Uint8Array; taken: string },
) => Promise<string>;

type CommitOn = (
  snapshot: Snapshot,
  asked: { changes: TreeChange[]; message: string; moved?: () => Error },
) => Promise<string>;

/** Whether the file is still the blob it was read as: its version, and its text's git name. */
async function isAsRead(snapshot: Snapshot, { path, modified, text }: AsRead): Promise<boolean> {
  const file = snapshot.files.get(path);
  if (file === undefined || versionOfBlob(file.sha) !== modified) return false;
  return (await gitBlobSha(utf8(text))) === file.sha;
}

/** A save of a note there, held to the blob it was read as, as `write_text` in vault.rs. */
async function saveText(
  { at, branch, commitOn }: Through & { commitOn: CommitOn },
  { path, contents, expectedModified, expectedText }: TextWrite,
): Promise<number> {
  refuseIf(heldPathRefusal(path));
  const snapshot = await at();
  refuseIf(heldFileRefusal(snapshot, path));
  const file = snapshot.files.get(path)!;
  const stale =
    (expectedModified !== null && versionOfBlob(file.sha) !== expectedModified) ||
    (expectedText !== undefined && (await gitBlobSha(utf8(expectedText))) !== file.sha);
  if (stale) refuse(HOST_CHANGED_ON_DISK);
  const bytes = utf8(contents);
  // The bytes already there: nothing to commit, and the note is not rewritten (ADR-0003).
  if ((await gitBlobSha(bytes)) === file.sha) return versionOfBlob(file.sha);
  const sha = await branch.upload(bytes);
  await commitOn(snapshot, { changes: [put(path, sha, file.mode)], message: `Save ${path}` });
  return versionOfBlob(sha);
}

/** Bytes written as vault_files.rs writes them: created at 0, appended at the length, replaced from 0. */
async function writeBytes(
  {
    at,
    branch,
    commitOn,
    create,
  }: Through & {
    commitOn: CommitOn;
    create: Create;
  },
  { path, bytes, offset, replace = false }: BinaryWrite,
): Promise<number> {
  refuseIf(heldPathRefusal(path));
  const snapshot = await at();
  const there = snapshot.files.get(path);
  const asked = { path, length: bytes.byteLength, offset, replace, sizeThere: there?.size ?? null };
  const { how } = unlessRefused(heldBinaryWrite(snapshot, asked));
  if (how === 'create') {
    await create(snapshot, { path, bytes, taken: HELD_REFUSAL.fileTaken });
    return bytes.byteLength;
  }
  const whole = how === 'replace' ? bytes : joined(await branch.blob(there!.sha), bytes);
  const sha = await branch.upload(whole);
  await commitOn(snapshot, { changes: [put(path, sha, there!.mode)], message: `Save ${path}` });
  return whole.byteLength;
}

function joined(before: Uint8Array, after: Uint8Array): Uint8Array {
  const whole = new Uint8Array(before.byteLength + after.byteLength);
  whole.set(before);
  whole.set(after, before.byteLength);
  return whole;
}
