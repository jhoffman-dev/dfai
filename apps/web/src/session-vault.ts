import {
  createVaultPath,
  HELD_REFUSAL,
  heldBinaryWrite,
  heldChildren,
  heldFileRefusal,
  heldFilesWithExtension,
  heldMove,
  heldPlaceRefusal,
  heldTrash,
  heldWalk,
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
} from '@dfai/application';

/**
 * The web stub's vault (#656): files held in memory for as long as the page
 * is open. It answers every call as the desktop's host does
 * (`apps/desktop/src-tauri/src/vault*.rs`), because that is the contract the
 * GitHub vault (#664) is built to, and `vaultFsContract` in
 * `@dfai/application/testing/vault-fs-contract` holds both to it:
 *
 * - A path is its segments: an empty, `.` or `..` segment is refused, and
 *   so is anything in git's own folder, `.git` in any case, read or write.
 * - Every write names the open vault, and is refused for any other (R14-01).
 * - A new file or folder needs its folder to be there; a save or a trash
 *   needs its entry to be there, and a save is never to a folder.
 * - **Names differ by more than case.** A create or a move onto a name that
 *   only differs in case from one there is refused, as the Mac's disk
 *   refuses it, because a vault synced between a Mac and GitHub breaks on
 *   two siblings like that. A move of an entry onto its own name in another
 *   case is that entry's rename, and is taken.
 * - A folder never moves into itself; a move onto its own path does nothing.
 * - Bytes are written from 0 or appended at exactly the length there,
 *   replaced whole only from 0, and never past 32 MB.
 * - A walk skips an entry, file or folder, by its own name at any level;
 *   notes are `.md` in any case, and a file listing is sorted.
 *
 * The rules themselves are the domain's (`held-vault.ts`), shared with the
 * GitHub vault; this holds the files. Nothing outlives a reload until the
 * GitHub vault takes its place.
 */

/** A file's text or bytes, and its version, which stands in for a time on disk. */
type Held = { readonly content: string | Uint8Array; readonly modified: number };

const refuse = (message: string): never => {
  throw new VaultAccessError(message);
};
/** Throws the host's refusal, when there is one. */
const refuseIf = (refusal: string | null) => {
  if (refusal !== null) refuse(refusal);
};
function unlessRefused<T extends object>(answer: Refused | T): T {
  if ('refused' in answer) return refuse(answer.refused);
  return answer;
}
const encoder = new TextEncoder();
const bytesOf = ({ content }: Held) =>
  typeof content === 'string' ? encoder.encode(content) : content;
/** A file's text, or null when it holds bytes that are not UTF-8, as the host reads it. */
function textOf({ content }: Held): string | null {
  if (typeof content === 'string') return content;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    // Not UTF-8: the host refuses it as text too, and the caller says so.
    return null;
  }
}

/** The files and folders of one session, and the counter their versions come from. */
class SessionFiles implements HeldVault<Held> {
  readonly files = new Map<string, Held>();
  readonly folders = new Set<string>();
  private version = 0;

  constructor(seed: Readonly<Record<string, string>>) {
    for (const [path, text] of Object.entries(seed)) this.put(path, text);
  }

  put(path: string, content: string | Uint8Array): number {
    const modified = ++this.version;
    this.files.set(path, { content, modified });
    return modified;
  }

  held(path: string): Held {
    refuseIf(heldFileRefusal(this, path));
    return this.files.get(path)!;
  }
}

const directory = (path: string): VaultEntry => ({
  kind: 'directory',
  name: vaultPathName(createVaultPath(path)),
  path: createVaultPath(path),
});
const fileEntry = (path: string, held: Held): VaultEntry => ({
  kind: 'file',
  name: vaultPathName(createVaultPath(path)),
  path: createVaultPath(path),
  modified: held.modified,
  size: bytesOf(held).byteLength,
});

/** The folders' and files' names directly inside `folder`, by name, as the host lists them. */
function listDirectory(session: SessionFiles, folder: VaultPath): VaultEntry[] {
  return unlessRefused(heldChildren(session, folder)).children.map(({ kind, path }) =>
    kind === 'file' ? fileEntry(path, session.files.get(path)!) : directory(path),
  );
}

type TextWrite = Parameters<HostVaultFsPort['writeTextFile']>[0];
type BinaryWrite = Parameters<HostVaultFsPort['writeBinaryFile']>[0];

/** A save of a note there, held to the version it was read at, as `write_text` in vault.rs. */
function writeText(
  session: SessionFiles,
  { path, contents, expectedModified, expectedText }: TextWrite,
) {
  const before = session.held(path);
  const stale =
    (expectedModified !== null && before.modified !== expectedModified) ||
    (expectedText !== undefined && textOf(before) !== expectedText);
  if (stale) refuse(HOST_CHANGED_ON_DISK);
  return session.put(path, contents);
}

/** Bytes written as vault_files.rs writes them: created at 0, appended at the length, replaced from 0. */
function writeBinary(session: SessionFiles, { path, bytes, offset, replace = false }: BinaryWrite) {
  const there = session.files.get(path);
  const sizeThere = there === undefined ? null : bytesOf(there).byteLength;
  const asked = { path, length: bytes.byteLength, offset, replace, sizeThere };
  const { how } = unlessRefused(heldBinaryWrite(session, asked));
  if (how !== 'append') {
    session.put(path, bytes.slice());
    return bytes.byteLength;
  }
  const joined = new Uint8Array(offset + bytes.byteLength);
  joined.set(bytesOf(there!));
  joined.set(bytes, offset);
  session.put(path, joined);
  return joined.byteLength;
}

/** Moves a file or a folder with everything in it, as `move_entry_at` in vault_entries.rs. */
function move(session: SessionFiles, { from, to }: { from: VaultPath; to: VaultPath }): void {
  const { renames } = unlessRefused(heldMove(session, { from, to }));
  for (const [was, now] of renames) {
    const held = session.files.get(was);
    if (held === undefined) {
      session.folders.delete(was);
      session.folders.add(now);
    } else {
      session.files.delete(was);
      session.files.set(now, held);
    }
  }
}

/** Trashes a file or a folder, refusing when a file it was told is as read has changed. */
function trash(
  session: SessionFiles,
  { path, unchanged = [] }: { path: VaultPath; unchanged?: readonly AsRead[] },
) {
  const gone = unlessRefused(heldTrash(session, path));
  for (const file of unchanged) {
    const held = session.files.get(file.path);
    if (held?.modified !== file.modified || textOf(held) !== file.text)
      throw new EntryChangedError(
        'a file changed on disk since it was read, so nothing was moved to the Trash',
      );
  }
  for (const file of gone.files) session.files.delete(file);
  for (const folder of gone.folders) session.folders.delete(folder);
}

/** Every write, refused unless it names the open vault (R14-01). */
function forTheOpenVault<Args extends { vault: string }, Result>(
  open: string,
  write: (args: Args) => Result,
): (args: Args) => Promise<Result> {
  return async (args) => {
    if (args.vault !== open) refuse(`${args.vault} is not the open vault`);
    return write(args);
  };
}

/**
 * The reads the shell makes of the session's notes and files. Its `modified`
 * is a count of writes, a version and no time, so each read says the time is
 * unknown (ADR-0053).
 */
function reads(session: SessionFiles) {
  const readText = (path: string) => {
    const held = session.held(path);
    const text = textOf(held);
    if (text === null) return refuse('not a text file');
    return { text, modified: held.modified, modifiedAt: null };
  };
  return {
    listDirectory: async (folder: VaultPath) => listDirectory(session, folder),
    listNotes: async (walk: { skipDirectories: readonly string[]; maxDepth: number }) =>
      heldWalk(session, walk)
        .filter(isHeldNote)
        .map((path) => {
          const held = session.files.get(path)!;
          return {
            name: vaultPathName(createVaultPath(path)),
            path: createVaultPath(path),
            modified: held.modified,
            modifiedAt: null,
            size: bytesOf(held).byteLength,
          };
        }),
    listFiles: async (walk: Parameters<HostVaultFsPort['listFiles']>[0]) =>
      heldFilesWithExtension(session, walk).map(createVaultPath),
    readNotes: async (paths: readonly string[]) =>
      paths.flatMap((path) => {
        const held = session.files.get(path);
        const text = held === undefined ? null : textOf(held);
        return held === undefined || text === null
          ? []
          : [{ path, text, modified: held.modified, modifiedAt: null, size: bytesOf(held).byteLength }];
      }),
    readTextFile: async (path: VaultPath) => readText(path),
    readBinaryFile: async (path: VaultPath) => bytesOf(session.held(path)).slice().buffer,
  };
}

/** The session's one vault, by the key every write names. */
export const SESSION_VAULT = '/sample';

export function sessionVaultFs(
  seed: Readonly<Record<string, string>>,
  { vault = SESSION_VAULT }: { vault?: string } = {},
): HostVaultFsPort {
  const session = new SessionFiles(seed);
  return {
    ...reads(session),
    createNote: forTheOpenVault(vault, ({ path, contents }) => {
      refuseIf(heldPlaceRefusal(session, { path, taken: HELD_REFUSAL.noteTaken }));
      return session.put(path, contents);
    }),
    createFolder: forTheOpenVault(vault, ({ path }) => {
      refuseIf(heldPlaceRefusal(session, { path, taken: HELD_REFUSAL.nameTaken }));
      session.folders.add(path);
    }),
    moveEntry: forTheOpenVault(vault, (args) => move(session, args)),
    trashEntry: forTheOpenVault(vault, (args) => trash(session, args)),
    writeTextFile: forTheOpenVault(vault, (args: TextWrite & { vault: string }) =>
      writeText(session, args),
    ),
    writeBinaryFile: forTheOpenVault(vault, (args: BinaryWrite & { vault: string }) =>
      writeBinary(session, args),
    ),
  };
}
