import { invoke } from '@tauri-apps/api/core';
import {
  createVaultPath,
  InvalidVaultPathError,
  moveRepointsLinkRefusal,
  moveThroughLinkRefusal,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import {
  EntryChangedError,
  MoveRefusedError,
  VaultAccessError,
  type AsRead,
  type HostVaultFsPort,
  type NoteContents,
} from '@dfai/application';
import { throughHost } from './host-error.ts';

/** What `vault_entries.rs` refuses a trash with when a file it was to hold still has changed. */
const TRASH_REFUSED_AS_CHANGED =
  'a file changed on disk since it was read, so nothing was moved to the Trash';

/** How `vault_entries.rs` begins the move refusals the domain has words for, each naming a link (#680). */
const MOVE_REFUSALS: readonly (readonly [string, (link: VaultPath) => string])[] = [
  ['path goes through a link: ', moveThroughLinkRefusal],
  ['moving it would point a link elsewhere: ', moveRepointsLinkRefusal],
];

/** A refused move in the domain's words when the host's are one of those, else as the host said it. */
function moveRefused(message: string): Error {
  for (const [start, words] of MOVE_REFUSALS) {
    if (!message.startsWith(start)) continue;
    try {
      return new MoveRefusedError(words(createVaultPath(message.slice(start.length))));
    } catch (cause) {
      // A link may be named what no vault path may be (`a\b`): then the host's own words.
      if (cause instanceof InvalidVaultPathError) return new MoveRefusedError(message);
      throw cause;
    }
  }
  return new VaultAccessError(message);
}

/** The shape the Rust side sends back. Validated here before it becomes a domain type. */
interface RawEntry {
  name: string;
  path: string;
  kind: string;
  modified: number;
  size: number;
  link?: boolean;
}

interface RawNoteFile {
  path: string;
  text: string;
  modified: number;
  size: number;
}

/** SHA-256 of the text's UTF-8 bytes, in lowercase hex, as the host's `digest_of` makes it. */
async function digestOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toEntry(raw: RawEntry): VaultEntry {
  const path = createVaultPath(raw.path);
  const link = raw.link === true && { link: true as const };
  if (raw.kind === 'directory') return { kind: 'directory', name: raw.name, path, ...link };
  return {
    kind: 'file',
    name: raw.name,
    path,
    ...(typeof raw.modified === 'number' && { modified: raw.modified }),
    ...(typeof raw.size === 'number' && { size: raw.size }),
    ...link,
  };
}

export const tauriVaultFs: HostVaultFsPort = {
  async listDirectory(path: VaultPath) {
    const raw = await throughHost(invoke<RawEntry[]>('list_directory', { path }));
    return raw.map(toEntry);
  },

  async listNotes({
    skipDirectories,
    maxDepth,
  }: {
    skipDirectories: readonly string[];
    maxDepth: number;
  }) {
    const raw = await throughHost(
      invoke<RawEntry[]>('list_notes', { skipDirectories: [...skipDirectories], maxDepth }),
    );
    return raw.map((note) => ({
      name: note.name,
      path: createVaultPath(note.path),
      modified: note.modified,
      size: note.size,
    }));
  },

  async listFiles({
    extension,
    skipDirectories,
    maxDepth,
  }: {
    extension: string;
    skipDirectories: readonly string[];
    maxDepth: number;
  }) {
    const raw = await throughHost(
      invoke<string[]>('list_vault_files', {
        extension,
        skipDirectories: [...skipDirectories],
        maxDepth,
      }),
    );
    return raw.map((path) => createVaultPath(path));
  },

  readNotes(paths: readonly string[]) {
    return throughHost(invoke<RawNoteFile[]>('read_notes', { paths }));
  },

  readTextFile(path: VaultPath) {
    return throughHost(invoke<NoteContents>('read_text_file', { path }));
  },

  readBinaryFile(path: VaultPath) {
    return throughHost(invoke<ArrayBuffer>('read_binary_file', { path }));
  },

  // `vault` is passed on for the host to compare with the vault it has open;
  // which vault a write belongs to is decided before it gets here.
  createNote({ path, contents, vault }: { path: VaultPath; contents: string; vault: string }) {
    return throughHost(invoke<number>('create_note', { path, contents, vault }));
  },

  async createFolder({ path, vault }: { path: VaultPath; vault: string }) {
    await throughHost(invoke('create_folder', { path, vault }));
  },

  async moveEntry({ from, to, vault }: { from: VaultPath; to: VaultPath; vault: string }) {
    await throughHost(invoke('move_entry', { from, to, vault }), moveRefused);
  },

  // Each file the host is to hold still crosses as its time and its digest (#235).
  async trashEntry({
    path,
    vault,
    unchanged,
  }: {
    path: VaultPath;
    vault: string;
    unchanged?: readonly AsRead[];
  }) {
    const held =
      unchanged === undefined
        ? undefined
        : await Promise.all(
            unchanged.map(async (file) => ({
              path: file.path,
              modified: file.modified,
              digest: await digestOf(file.text),
            })),
          );
    await throughHost(
      invoke('trash_entry', { path, vault, ...(held !== undefined && { unchanged: held }) }),
      (message) =>
        message === TRASH_REFUSED_AS_CHANGED
          ? new EntryChangedError(message)
          : new VaultAccessError(message),
    );
  },

  // The text a save was read as crosses as its digest, which the host
  // compares with the note's bytes (#245): not a second copy of the note.
  async writeTextFile({
    path,
    contents,
    expectedModified,
    expectedText,
    vault,
  }: {
    path: VaultPath;
    contents: string;
    expectedModified: number | null;
    expectedText?: string;
    vault: string;
  }) {
    const expectedDigest = expectedText === undefined ? undefined : await digestOf(expectedText);
    return throughHost(
      invoke<number>('write_text_file', {
        path,
        contents,
        expectedModified,
        ...(expectedDigest !== undefined && { expectedDigest }),
        vault,
      }),
    );
  },

  // The bytes go as the raw body rather than a JSON array of numbers, which
  // would be four times their size; what they are for goes in headers, which
  // carry only ASCII, so the path and vault are percent-encoded.
  writeBinaryFile({
    path,
    bytes,
    offset,
    replace = false,
    vault,
  }: {
    path: VaultPath;
    bytes: Uint8Array;
    offset: number;
    replace?: boolean;
    vault: string;
  }) {
    const headers: Record<string, string> = {
      [BINARY_HEADERS.path]: encodeURIComponent(path),
      [BINARY_HEADERS.offset]: String(offset),
      ...(replace && { [BINARY_HEADERS.replace]: '1' }),
      [BINARY_HEADERS.vault]: encodeURIComponent(vault),
    };
    return throughHost(invoke<number>('write_binary_file', bytes, { headers }));
  },
};

/** The headers `write_binary_file` reads, as `vault.rs` names them. */
export const BINARY_HEADERS = {
  path: 'atlas-path',
  offset: 'atlas-offset',
  vault: 'atlas-vault',
  replace: 'atlas-replace',
} as const;
