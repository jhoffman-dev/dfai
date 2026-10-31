import {
  createVaultPath,
  isMarkdownFile,
  parentVaultPath,
  vaultPathDepth,
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
 * is open, answering every call as the desktop's host does — a write is kept
 * and read back, a stale one or one over a file already there is refused. The
 * GitHub vault (#664) takes its place; until then nothing outlives a reload.
 */

/** A file's text or bytes, and its version, which stands in for a time on disk. */
type Held = { readonly content: string | Uint8Array; readonly modified: number };

const encoder = new TextEncoder();
const bytesOf = (held: Held) =>
  typeof held.content === 'string' ? encoder.encode(held.content) : held.content;
const isUnder = (path: string, folder: string) => folder === '' || path.startsWith(`${folder}/`);
const fileEntry = (path: string, held: Held): VaultEntry => ({
  kind: 'file',
  name: vaultPathName(createVaultPath(path)),
  path: createVaultPath(path),
  modified: held.modified,
  size: bytesOf(held).byteLength,
});

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

  has(path: string): boolean {
    return this.files.has(path) || this.isFolder(path);
  }

  isFolder(path: string): boolean {
    if (path === '' || this.folders.has(path)) return true;
    return [...this.files.keys()].some((file) => isUnder(file, path));
  }

  held(path: string): Held {
    const held = this.files.get(path);
    if (held === undefined) throw new VaultAccessError('no such entry');
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
}

/** The folders' and files' names directly inside `folder`. */
function listDirectory(session: SessionFiles, folder: VaultPath): VaultEntry[] {
  if (!session.isFolder(folder)) throw new VaultAccessError('no such entry');
  const entries = new Map<string, VaultEntry>();
  const childOf = (path: string) => {
    const rest = folder === '' ? path : path.slice(folder.length + 1);
    return folder === '' ? rest.split('/')[0]! : `${folder}/${rest.split('/')[0]!}`;
  };
  for (const [path, held] of session.files) {
    if (!isUnder(path, folder)) continue;
    const child = childOf(path);
    entries.set(child, child === path ? fileEntry(path, held) : directory(child));
  }
  for (const path of session.folders) {
    if (path !== folder && isUnder(path, folder) && !entries.has(childOf(path)))
      entries.set(childOf(path), directory(childOf(path)));
  }
  return [...entries.values()];
}

const directory = (path: string): VaultEntry => ({
  kind: 'directory',
  name: vaultPathName(createVaultPath(path)),
  path: createVaultPath(path),
});

/** The files a walk reaches: below `maxDepth` folders, and in none of `skipDirectories`. */
function walked(
  session: SessionFiles,
  { skipDirectories, maxDepth }: { skipDirectories: readonly string[]; maxDepth: number },
): [string, Held][] {
  const skipped = (path: string) =>
    path
      .split('/')
      .slice(0, -1)
      .some((name, index, folders) =>
        [name, folders.slice(0, index + 1).join('/')].some((it) => skipDirectories.includes(it)),
      );
  return [...session.files].filter(
    ([path]) => vaultPathDepth(createVaultPath(path)) - 1 <= maxDepth && !skipped(path),
  );
}

/** A text write held to the version it was read at, as the host holds it (`vault.rs`). */
function writeText(
  session: SessionFiles,
  {
    path,
    contents,
    expectedModified,
    expectedText,
  }: Parameters<HostVaultFsPort['writeTextFile']>[0],
): number {
  const before = session.files.get(path);
  const stale =
    before !== undefined &&
    ((expectedModified !== null && before.modified !== expectedModified) ||
      (expectedText !== undefined && before.content !== expectedText));
  if (stale) throw new VaultAccessError(HOST_CHANGED_ON_DISK);
  return session.put(path, contents);
}

/** Bytes written as the host writes them: created at 0, appended past it, or replaced whole. */
function writeBinary(
  session: SessionFiles,
  { path, bytes, offset, replace = false }: Parameters<HostVaultFsPort['writeBinaryFile']>[0],
): number {
  const before = session.files.get(path);
  if (replace || offset === 0) {
    if (!replace && session.has(path)) throw new VaultAccessError('that file already exists');
    session.put(path, bytes.slice());
    return bytes.byteLength;
  }
  const held = before === undefined ? null : bytesOf(before);
  if (held === null || held.byteLength !== offset)
    throw new VaultAccessError('the file is not as long as the write expects');
  const joined = new Uint8Array(offset + bytes.byteLength);
  joined.set(held);
  joined.set(bytes, offset);
  session.put(path, joined);
  return joined.byteLength;
}

/** Moves a file or a folder with everything in it, refusing to land on anything there. */
function move(session: SessionFiles, { from, to }: { from: VaultPath; to: VaultPath }): void {
  if (!session.has(from)) throw new VaultAccessError('no such entry');
  if (session.has(to)) throw new VaultAccessError('something with that name is already there');
  if (!session.isFolder(parentVaultPath(to))) throw new VaultAccessError('no such folder');
  const moved = session.under(from);
  const renamed = (path: string) => `${to}${path.slice(from.length)}`;
  for (const path of moved.files) {
    const held = session.held(path);
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
): void {
  if (!session.has(path)) throw new VaultAccessError('no such entry');
  for (const file of unchanged) {
    const held = session.files.get(file.path);
    if (held?.modified !== file.modified || held.content !== file.text)
      throw new EntryChangedError('a file changed since it was read, so nothing was trashed');
  }
  const gone = session.under(path);
  for (const file of gone.files) session.files.delete(file);
  for (const folder of gone.folders) session.folders.delete(folder);
}

export function sessionVaultFs(seed: Readonly<Record<string, string>>): HostVaultFsPort {
  const session = new SessionFiles(seed);
  const textOf = (path: string) => {
    const held = session.held(path);
    if (typeof held.content !== 'string') throw new VaultAccessError('not a text file');
    return { text: held.content, modified: held.modified };
  };
  return {
    listDirectory: async (folder) => listDirectory(session, folder),
    listNotes: async (walk) =>
      walked(session, walk).flatMap(([path, held]) => {
        const entry = fileEntry(path, held);
        if (entry.kind !== 'file' || !isMarkdownFile(entry)) return [];
        return [
          { name: entry.name, path: entry.path, modified: held.modified, size: entry.size ?? 0 },
        ];
      }),
    listFiles: async ({ extension, ...walk }) =>
      walked(session, walk)
        .map(([path]) => createVaultPath(path))
        .filter((path) => path.toLowerCase().endsWith(`.${extension.toLowerCase()}`)),
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const held = session.files.get(path);
        if (typeof held?.content !== 'string') return [];
        return [
          { path, text: held.content, modified: held.modified, size: bytesOf(held).byteLength },
        ];
      }),
    readTextFile: async (path) => textOf(path),
    readBinaryFile: async (path) => bytesOf(session.held(path)).slice().buffer,
    createNote: async ({ path, contents }) => {
      if (session.has(path)) throw new VaultAccessError('a note with that name already exists');
      return session.put(path, contents);
    },
    createFolder: async ({ path }) => {
      if (session.has(path))
        throw new VaultAccessError('something with that name is already there');
      if (!session.isFolder(parentVaultPath(path))) throw new VaultAccessError('no such folder');
      session.folders.add(path);
    },
    moveEntry: async (args) => move(session, args),
    trashEntry: async (args) => trash(session, args),
    writeTextFile: async (args) => writeText(session, args),
    writeBinaryFile: async (args) => writeBinary(session, args),
  };
}
