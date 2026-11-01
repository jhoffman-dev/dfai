import {
  createVaultPath,
  parentVaultPath,
  vaultPathName,
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
 * Nothing outlives a reload until the GitHub vault takes its place.
 */

/** A file's text or bytes, and its version, which stands in for a time on disk. */
type Held = { readonly content: string | Uint8Array; readonly modified: number };

/** The host's ceiling on a file written as bytes (`MAX_BINARY_BYTES` in vault.rs). */
export const MAX_BINARY_BYTES = 32 * 1024 * 1024;

const refuse = (message: string): never => {
  throw new VaultAccessError(message);
};
const encoder = new TextEncoder();
const bytesOf = ({ content }: Held) =>
  typeof content === 'string' ? encoder.encode(content) : content;
/** A file's text, or null when it holds bytes that are not UTF-8, as the host reads it. */
function textOf({ content }: Held): string | null {
  if (typeof content === 'string') return content;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    // Not UTF-8: the host refuses it as text too, and the caller says so.
    return null;
  }
}
const isUnder = (path: string, folder: string) => folder === '' || path.startsWith(`${folder}/`);
/** A note, as the host's walk knows one: `.md` in any case. */
const isNoteName = (path: string) => path.toLowerCase().endsWith('.md');

/** The path checks every call makes first, as `resolve` in vault.rs does. */
function checked(path: string): string {
  if (path.includes('\0')) refuse('path contains a null byte');
  const segments = path.split('/');
  if (
    path !== '' &&
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    refuse(`path segment in ${JSON.stringify(path)} is not allowed`);
  if (segments.some((segment) => segment.toLowerCase() === '.git'))
    refuse("git's own folder is not part of the vault");
  return path;
}

/** The files and folders of one session, and the counter their versions come from. */
class SessionFiles {
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

  isFolder(path: string): boolean {
    if (path === '' || this.folders.has(path)) return true;
    return [...this.files.keys()].some((file) => isUnder(file, path));
  }

  has(path: string): boolean {
    return this.files.has(path) || this.isFolder(path);
  }

  /** What is at a name that only differs from `path` in case, if anything: the Mac's disk sees one name. */
  sameNameAs(path: string): string | null {
    const folded = path.toLowerCase();
    const names = [...this.files.keys(), ...this.folders, ...this.impliedFolders()];
    return names.find((name) => name.toLowerCase() === folded) ?? null;
  }

  held(path: string): Held {
    const held = this.files.get(checked(path));
    if (held === undefined)
      return refuse(this.isFolder(path) ? 'that is a directory' : 'no such entry');
    return held;
  }

  /** Every file and folder at `path` or under it, which a move or a trash takes with it. */
  under(path: string): { files: string[]; folders: string[] } {
    const within = (other: string) => other === path || isUnder(other, path);
    return {
      files: [...this.files.keys()].filter(within),
      folders: [...this.folders].filter(within),
    };
  }

  private impliedFolders(): string[] {
    return [...this.files.keys()].flatMap((file) => {
      const segments = file.split('/').slice(0, -1);
      return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
    });
  }
}

/** Where a new entry may go: its folder there, and no name there that differs only in case. */
function placeFor(session: SessionFiles, path: string, taken: string): string {
  checked(path);
  if (!session.isFolder(parentVaultPath(path as VaultPath))) refuse('that folder does not exist');
  if (session.sameNameAs(path) !== null) refuse(taken);
  return path;
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
  checked(folder);
  if (!session.isFolder(folder))
    refuse(session.files.has(folder) ? 'that is not a folder' : 'no such entry');
  const childOf = (path: string) => {
    const first = (folder === '' ? path : path.slice(folder.length + 1)).split('/')[0]!;
    return folder === '' ? first : `${folder}/${first}`;
  };
  const entries = new Map<string, VaultEntry>();
  for (const [path, held] of session.files) {
    if (!isUnder(path, folder)) continue;
    const child = childOf(path);
    entries.set(child, child === path ? fileEntry(path, held) : directory(child));
  }
  for (const path of session.folders) {
    if (path !== folder && isUnder(path, folder) && !entries.has(childOf(path)))
      entries.set(childOf(path), directory(childOf(path)));
  }
  return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The files a walk reaches: in folders at most `maxDepth` down, past no entry it was told to skip. */
function walked(
  session: SessionFiles,
  { skipDirectories, maxDepth }: { skipDirectories: readonly string[]; maxDepth: number },
): [string, Held][] {
  const skip = new Set(skipDirectories);
  return [...session.files].filter(([path]) => {
    const segments = path.split('/');
    return segments.length - 1 <= maxDepth && !segments.some((name) => skip.has(name));
  });
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
  checked(path);
  if (offset + bytes.byteLength > MAX_BINARY_BYTES) refuse('a file is at most 32 MB');
  if (replace) return replaceBinary(session, path, bytes, offset);
  if (offset === 0) {
    placeFor(session, path, 'that file already exists');
    session.put(path, bytes.slice());
    return bytes.byteLength;
  }
  const held = bytesOf(session.held(path));
  if (held.byteLength !== offset) refuse('the file is not the length the write expected');
  const joined = new Uint8Array(offset + bytes.byteLength);
  joined.set(held);
  joined.set(bytes, offset);
  session.put(path, joined);
  return joined.byteLength;
}

function replaceBinary(session: SessionFiles, path: string, bytes: Uint8Array, offset: number) {
  if (offset !== 0) refuse('a file is replaced whole, from offset 0');
  if (session.isFolder(path)) refuse('that is a directory');
  if (!session.files.has(path)) placeFor(session, path, 'that file already exists');
  session.put(path, bytes.slice());
  return bytes.byteLength;
}

/** Moves a file or a folder with everything in it, as `move_entry_at` in vault_entries.rs. */
function move(session: SessionFiles, { from, to }: { from: VaultPath; to: VaultPath }): void {
  if (!session.has(checked(from))) refuse('no such entry');
  checked(to);
  if (from === to) return;
  if (
    session.isFolder(from) &&
    (parentVaultPath(to) === from || isUnder(parentVaultPath(to), from))
  )
    refuse('a folder cannot be moved into itself');
  const renamesItself = from.toLowerCase() === to.toLowerCase();
  if (!renamesItself) placeFor(session, to, 'something with that name is already there');
  else if (!session.isFolder(parentVaultPath(to))) refuse('that folder does not exist');
  const moved = session.under(from);
  const renamed = (path: string) => `${to}${path.slice(from.length)}`;
  for (const path of moved.files) {
    const held = session.files.get(path)!;
    session.files.delete(path);
    session.files.set(renamed(path), held);
  }
  for (const path of moved.folders) {
    session.folders.delete(path);
    session.folders.add(renamed(path));
  }
}

/** Trashes a file or a folder, refusing when a file it was told is as read has changed. */
function trash(
  session: SessionFiles,
  { path, unchanged = [] }: { path: VaultPath; unchanged?: readonly AsRead[] },
) {
  if (!session.has(checked(path))) refuse('no such entry');
  for (const file of unchanged) {
    const held = session.files.get(file.path);
    if (held?.modified !== file.modified || textOf(held) !== file.text)
      throw new EntryChangedError(
        'a file changed on disk since it was read, so nothing was moved to the Trash',
      );
  }
  const gone = session.under(path);
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

/** The reads the shell makes of the session's notes and files. */
function reads(session: SessionFiles) {
  const readText = (path: string) => {
    const held = session.held(path);
    const text = textOf(held);
    if (text === null) return refuse('not a text file');
    return { text, modified: held.modified };
  };
  return {
    listDirectory: async (folder: VaultPath) => listDirectory(session, folder),
    listNotes: async (walk: { skipDirectories: readonly string[]; maxDepth: number }) =>
      walked(session, walk)
        .filter(([path]) => isNoteName(path))
        .map(([path, held]) => ({
          name: vaultPathName(createVaultPath(path)),
          path: createVaultPath(path),
          modified: held.modified,
          size: bytesOf(held).byteLength,
        })),
    listFiles: async ({ extension, ...walk }: Parameters<HostVaultFsPort['listFiles']>[0]) =>
      walked(session, walk)
        .map(([path]) => path)
        .filter((path) => path.toLowerCase().endsWith(`.${extension.toLowerCase()}`))
        .sort()
        .map(createVaultPath),
    readNotes: async (paths: readonly string[]) =>
      paths.flatMap((path) => {
        const held = session.files.get(path);
        const text = held === undefined ? null : textOf(held);
        return held === undefined || text === null
          ? []
          : [{ path, text, modified: held.modified, size: bytesOf(held).byteLength }];
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
      placeFor(session, path, 'a note with that name already exists');
      return session.put(path, contents);
    }),
    createFolder: forTheOpenVault(vault, ({ path }) => {
      session.folders.add(placeFor(session, path, 'something with that name is already there'));
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
