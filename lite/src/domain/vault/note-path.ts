/**
 * A file's path in the vault: `/`-separated, relative to the vault's root,
 * with no leading or trailing slash — `Projects/Larkspur rollout.md`. The
 * root folder is the empty string.
 */
export type VaultPath = string;

export const VAULT_ROOT: VaultPath = '';

const MARKDOWN = /\.md$/i;

/** Whether the file is a note: a `.md` file. */
export function isNotePath(path: VaultPath): boolean {
  return MARKDOWN.test(path);
}

/** The last part of a path: `Name.md` of `Folder/Name.md`. */
export function fileNameOf(path: VaultPath): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The folder a path is in: `Folder` of `Folder/Name.md`, the root for a root file. */
export function folderOf(path: VaultPath): VaultPath {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? VAULT_ROOT : path.slice(0, slash);
}

/** A note's title: its file name without `.md`. The vault has no other title. */
export function noteTitle(path: VaultPath): string {
  return fileNameOf(path).replace(MARKDOWN, '');
}

/** The path without its `.md`: how a link written as a path names a note. */
export function withoutExtension(path: VaultPath): string {
  return path.replace(MARKDOWN, '');
}

/** `folder/name`, or `name` alone in the root. */
export function joinPath(folder: VaultPath, name: string): VaultPath {
  return folder === VAULT_ROOT ? name : `${folder}/${name}`;
}

/** How many folders deep a path is: 0 for a root file. */
export function pathDepth(path: VaultPath): number {
  let depth = 0;
  for (const char of path) if (char === '/') depth += 1;
  return depth;
}

/** Whether `path` is `folder` itself or anywhere under it. The root holds everything. */
export function isWithin(path: VaultPath, folder: VaultPath): boolean {
  return folder === VAULT_ROOT || path === folder || path.startsWith(`${folder}/`);
}

/** Paths as the vault compares them for clashes: case folded, accents composed one way. */
export function foldedPath(path: VaultPath): string {
  return path.normalize('NFC').toLowerCase();
}

/** One moved file or folder: everything at or under `from` goes to the same place under `to`. */
export interface PathMove {
  readonly from: VaultPath;
  readonly to: VaultPath;
}

/** Where `path` is after the move, or null when the move leaves it be. */
export function pathAfterMove(path: VaultPath, move: PathMove): VaultPath | null {
  if (path === move.from) return move.to;
  if (move.from !== VAULT_ROOT && path.startsWith(`${move.from}/`)) {
    return `${move.to}${path.slice(move.from.length)}`;
  }
  return null;
}
