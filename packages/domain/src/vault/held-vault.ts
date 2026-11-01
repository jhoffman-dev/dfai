import { parentVaultPath, type VaultPath } from './vault-path.ts';

/**
 * The host's rules for a vault held as a map of files rather than a disk:
 * the web's session vault (#656) and the GitHub vault (#664). The desktop's
 * host (`apps/desktop/src-tauri/src/vault*.rs`) keeps them as its disk and its
 * checks do; these are the same rules, written once, so `vaultFsContract`
 * holds every vault to one behaviour and no adapter decides one for itself.
 *
 * Each rule answers a refusal, the host's own message, or what to do; the
 * adapter throws the refusal and does the rest.
 */
export interface HeldVault<File> {
  readonly files: ReadonlyMap<string, File>;
  /** Folders held as such, empty ones among them; a folder that holds a file need not be listed. */
  readonly folders: ReadonlySet<string>;
}

/** The host's ceiling on a file written as bytes (`MAX_BINARY_BYTES` in vault.rs). */
export const MAX_HELD_BINARY_BYTES = 32 * 1024 * 1024;

/** The host's refusals, word for word, as the app and the contract match them. */
export const HELD_REFUSAL = {
  noEntry: 'no such entry',
  isDirectory: 'that is a directory',
  notFolder: 'that is not a folder',
  noFolder: 'that folder does not exist',
  noteTaken: 'a note with that name already exists',
  fileTaken: 'that file already exists',
  nameTaken: 'something with that name is already there',
  intoItself: 'a folder cannot be moved into itself',
  tooBig: 'a file is at most 32 MB',
  fromZero: 'a file is replaced whole, from offset 0',
  wrongLength: 'the file is not the length the write expected',
  gitFolder: "git's own folder is not part of the vault",
  nullByte: 'path contains a null byte',
} as const;

/** Refused, with the host's message. */
export type Refused = { readonly refused: string };

const isUnder = (path: string, folder: string) => folder === '' || path.startsWith(`${folder}/`);
const within = (path: string, entry: string) => path === entry || isUnder(path, entry);

/** The checks every call makes first, as `resolve` in vault.rs: no empty, `.` or `..` segment, nothing of `.git`. */
export function heldPathRefusal(path: string): string | null {
  if (path.includes('\0')) return HELD_REFUSAL.nullByte;
  const segments = path.split('/');
  const odd = (segment: string) => segment === '' || segment === '.' || segment === '..';
  if (path !== '' && segments.some(odd))
    return `path segment in ${JSON.stringify(path)} is not allowed`;
  if (segments.some((segment) => segment.toLowerCase() === '.git')) return HELD_REFUSAL.gitFolder;
  return null;
}

export function isHeldFolder<File>(vault: HeldVault<File>, path: string): boolean {
  if (path === '' || vault.folders.has(path)) return true;
  for (const file of vault.files.keys()) if (isUnder(file, path)) return true;
  return false;
}

/** Whether a file or a folder is at `path`. */
export function isHeld<File>(vault: HeldVault<File>, path: string): boolean {
  return vault.files.has(path) || isHeldFolder(vault, path);
}

/**
 * What is at a name that only differs from `path` in case, if anything. Names
 * differ by more than case, as the Mac's disk sees one name, because a vault
 * synced between a Mac and GitHub breaks on two siblings like that.
 */
export function heldNameLike<File>(vault: HeldVault<File>, path: string): string | null {
  const folded = path.toLowerCase();
  const matches = (name: string) => name.toLowerCase() === folded;
  for (const name of [...vault.files.keys(), ...vault.folders]) if (matches(name)) return name;
  for (const file of vault.files.keys()) {
    const segments = file.split('/').slice(0, -1);
    for (let end = 1; end <= segments.length; end++) {
      const folder = segments.slice(0, end).join('/');
      if (matches(folder)) return folder;
    }
  }
  return null;
}

/** Where a new entry may go: its folder there, and no name there that differs only in case. */
export function heldPlaceRefusal<File>(
  vault: HeldVault<File>,
  { path, taken }: { path: string; taken: string },
): string | null {
  const odd = heldPathRefusal(path);
  if (odd !== null) return odd;
  if (!isHeldFolder(vault, parentVaultPath(path as VaultPath))) return HELD_REFUSAL.noFolder;
  return heldNameLike(vault, path) === null ? null : taken;
}

/** Why a file cannot be read or saved, as a file: missing, or a folder. */
export function heldFileRefusal<File>(vault: HeldVault<File>, path: string): string | null {
  const odd = heldPathRefusal(path);
  if (odd !== null) return odd;
  if (vault.files.has(path)) return null;
  return isHeldFolder(vault, path) ? HELD_REFUSAL.isDirectory : HELD_REFUSAL.noEntry;
}

/** Every file and held folder at `path` or under it, which a move or a trash takes with it. */
export interface HeldEntries {
  readonly files: readonly string[];
  readonly folders: readonly string[];
}

export function heldUnder<File>(vault: HeldVault<File>, path: string): HeldEntries {
  return {
    files: [...vault.files.keys()].filter((file) => within(file, path)),
    folders: [...vault.folders].filter((folder) => within(folder, path)),
  };
}

/** A move to make: every path it carries, from where to where. */
export type HeldMove = { readonly renames: readonly (readonly [string, string])[] };

/**
 * A move of a file or a folder with everything in it, as `move_entry_at` in
 * vault_entries.rs: never onto something there, never a folder into itself; a
 * move onto its own path is nothing to do, one onto its own name in another
 * case is its rename.
 */
export function heldMove<File>(
  vault: HeldVault<File>,
  { from, to }: { from: string; to: string },
): Refused | HeldMove {
  const odd = heldPathRefusal(from) ?? heldPathRefusal(to);
  if (odd !== null) return { refused: odd };
  if (!isHeld(vault, from)) return { refused: HELD_REFUSAL.noEntry };
  if (from === to) return { renames: [] };
  const landing = parentVaultPath(to as VaultPath);
  if (isHeldFolder(vault, from) && within(landing, from))
    return { refused: HELD_REFUSAL.intoItself };
  const refusal =
    from.toLowerCase() === to.toLowerCase()
      ? isHeldFolder(vault, landing)
        ? null
        : HELD_REFUSAL.noFolder
      : heldPlaceRefusal(vault, { path: to, taken: HELD_REFUSAL.nameTaken });
  if (refusal !== null) return { refused: refusal };
  const { files, folders } = heldUnder(vault, from);
  const renamed = (path: string) => [path, `${to}${path.slice(from.length)}`] as const;
  return { renames: [...files, ...folders].map(renamed) };
}

/** How bytes go into a file: created at 0, appended at exactly its length, replaced whole from 0. */
export type HeldBinaryWrite = { readonly how: 'create' | 'append' | 'replace' };

export interface BinaryWriteAsked {
  readonly path: string;
  readonly length: number;
  readonly offset: number;
  readonly replace: boolean;
  /** The size of the file there now, when one is. */
  readonly sizeThere: number | null;
}

/** A write of bytes, as vault_files.rs takes one: never past 32 MB, never over a folder. */
export function heldBinaryWrite<File>(
  vault: HeldVault<File>,
  asked: BinaryWriteAsked,
): Refused | HeldBinaryWrite {
  const odd = heldPathRefusal(asked.path);
  if (odd !== null) return { refused: odd };
  if (asked.offset + asked.length > MAX_HELD_BINARY_BYTES) return { refused: HELD_REFUSAL.tooBig };
  if (asked.replace) return replacing(vault, asked);
  if (asked.offset === 0) return creating(vault, asked.path);
  const refusal = heldFileRefusal(vault, asked.path);
  if (refusal !== null) return { refused: refusal };
  if (asked.sizeThere !== asked.offset) return { refused: HELD_REFUSAL.wrongLength };
  return { how: 'append' };
}

function replacing<File>(vault: HeldVault<File>, asked: BinaryWriteAsked) {
  if (asked.offset !== 0) return { refused: HELD_REFUSAL.fromZero };
  if (isHeldFolder(vault, asked.path)) return { refused: HELD_REFUSAL.isDirectory };
  if (vault.files.has(asked.path)) return { how: 'replace' as const };
  return creating(vault, asked.path);
}

function creating<File>(vault: HeldVault<File>, path: string): Refused | HeldBinaryWrite {
  const refusal = heldPlaceRefusal(vault, { path, taken: HELD_REFUSAL.fileTaken });
  return refusal === null ? { how: 'create' } : { refused: refusal };
}

/** One entry directly inside a folder. */
export type HeldChild = { readonly kind: 'file' | 'directory'; readonly path: string };

/** The folders and files directly inside `folder`, by name in code-unit order, as the host lists them. */
export function heldChildren<File>(
  vault: HeldVault<File>,
  folder: string,
): Refused | { readonly children: readonly HeldChild[] } {
  const odd = heldPathRefusal(folder);
  if (odd !== null) return { refused: odd };
  if (!isHeldFolder(vault, folder))
    return { refused: vault.files.has(folder) ? HELD_REFUSAL.notFolder : HELD_REFUSAL.noEntry };
  const children = new Map<string, HeldChild>();
  const childOf = (path: string) => {
    const first = (folder === '' ? path : path.slice(folder.length + 1)).split('/')[0]!;
    return folder === '' ? first : `${folder}/${first}`;
  };
  for (const path of vault.files.keys()) {
    if (!isUnder(path, folder)) continue;
    const child = childOf(path);
    children.set(child, { kind: child === path ? 'file' : 'directory', path: child });
  }
  for (const path of vault.folders) {
    if (path === folder || !isUnder(path, folder) || children.has(childOf(path))) continue;
    children.set(childOf(path), { kind: 'directory', path: childOf(path) });
  }
  return { children: [...children.values()].sort((a, b) => compareCodeUnits(a.path, b.path)) };
}

const compareCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The files a walk reaches: at most `maxDepth` folders down, past no entry it was told to skip by name. */
export function heldWalk<File>(
  vault: HeldVault<File>,
  { skipDirectories, maxDepth }: { skipDirectories: readonly string[]; maxDepth: number },
): string[] {
  const skip = new Set(skipDirectories);
  return [...vault.files.keys()].filter((path) => {
    const segments = path.split('/');
    return segments.length - 1 <= maxDepth && !segments.some((name) => skip.has(name));
  });
}

/** A note, as the host's walk knows one: `.md` in any case. */
export const isHeldNote = (path: string): boolean => path.toLowerCase().endsWith('.md');

/** The files a walk reaches whose name ends `.extension` in any case, sorted. */
export function heldFilesWithExtension<File>(
  vault: HeldVault<File>,
  walk: { extension: string; skipDirectories: readonly string[]; maxDepth: number },
): string[] {
  const ending = `.${walk.extension.toLowerCase()}`;
  return heldWalk(vault, walk)
    .filter((path) => path.toLowerCase().endsWith(ending))
    .sort();
}
