import {
  isCachedNoteStale,
  VAULT_WALK_DEPTH,
  type CachedReadKind,
  type VaultPath,
} from '@dfai/domain';
import {
  VaultUnreachableError,
  type HostVaultFsPort,
  type NoteContents,
  type NoteFile,
} from '../vault/ports.ts';
import type { KeptReads } from './kept-reads.ts';
import type { ConnectionPort } from './ports.ts';

/** What a read says when nothing was kept of it and there is no network. */
export const NOTE_NEEDS_CONNECTION = 'This note is not on this device yet; it needs a connection';
export const FOLDER_NEEDS_CONNECTION =
  'This folder is not on this device yet; it needs a connection';
/**
 * What a write says with no network. A save or a new note waits in the
 * queue above (#667, #773) and never reaches here offline; a move, a trash
 * or a file's bytes do.
 */
export const WRITE_NEEDS_CONNECTION =
  'Saving needs a connection; your edit stays here until you are back online';
/**
 * What a new folder says with no network (#773). It is not queued: it holds
 * no typing to lose, and on GitHub a folder is only a placeholder file, so
 * queueing it would mean listing it, numbering it at send and moving every
 * note queued inside along with it.
 */
export const NEW_FOLDER_NEEDS_CONNECTION =
  'Making a folder needs a connection; new notes wait on this device, folders do not';

export interface CachedVaultFsDeps {
  readonly fs: HostVaultFsPort;
  readonly kept: KeptReads;
  readonly connection: ConnectionPort;
}

/**
 * The vault as the web build reads it (#667): the GitHub vault, with every
 * note opened and every listing of the tree kept on the device, so they are
 * answered with no network. Online, the network answers and what it said is
 * kept; offline, or when GitHub cannot be reached, what was kept answers,
 * and anything never kept says it needs a connection. A write goes to the
 * network only, and what it changed is kept or forgotten after.
 */
export function cachedVaultFs({ fs, kept, connection }: CachedVaultFsDeps): HostVaultFsPort {
  const keptRead = keptOrNetwork({ kept, connection });
  return {
    ...fs,
    listDirectory: (path) =>
      keptRead({ kind: 'directory', asked: path, read: () => fs.listDirectory(path) }),
    listNotes: (options) =>
      keptRead({
        kind: 'notes',
        asked: JSON.stringify(options),
        read: () => fs.listNotes(options),
      }),
    listFiles: (options) =>
      keptRead({
        kind: 'files',
        asked: JSON.stringify(options),
        read: () => fs.listFiles(options),
      }),
    readTextFile: (path) =>
      keptRead({
        kind: 'note',
        asked: path,
        read: () => fs.readTextFile(path),
        missing: NOTE_NEEDS_CONNECTION,
      }),
    readNotes: (paths) =>
      connection.online()
        ? fs.readNotes(paths).catch(orKeptNotes({ kept, paths }))
        : keptNotes(kept, paths),
    ...keptWrites({ fs, kept, connection }),
  };
}

/** A read answered by the network and kept, or by what was kept once there is none. */
function keptOrNetwork({ kept, connection }: Omit<CachedVaultFsDeps, 'fs'>) {
  return async <T>(asked: {
    kind: CachedReadKind;
    asked: string;
    read: () => Promise<T>;
    missing?: string;
  }): Promise<T> => {
    const fromDevice = async (cause?: unknown): Promise<T> => {
      const value = await kept.kept(asked.kind, asked.asked);
      // Kept from this same read's answer, so it is what the read answers.
      if (value !== undefined) return value as T;
      const message = asked.missing ?? FOLDER_NEEDS_CONNECTION;
      throw new VaultUnreachableError(
        cause instanceof Error ? `${message} (${cause.message})` : message,
      );
    };
    if (!connection.online()) return fromDevice();
    const ticket = kept.ticket();
    try {
      const value = await asked.read();
      void kept.keep(asked.kind, asked.asked, value, ticket);
      return value;
    } catch (error) {
      if (error instanceof VaultUnreachableError) return fromDevice(error);
      throw error;
    }
  };
}

/** The notes asked for that this device kept; the rest are left out, as unreadable ones are. */
async function keptNotes(kept: KeptReads, paths: readonly string[]): Promise<readonly NoteFile[]> {
  const found: NoteFile[] = [];
  for (const path of paths) {
    const note = (await kept.kept('note', path)) as NoteContents | undefined;
    if (note !== undefined)
      found.push({ path, text: note.text, modified: note.modified, size: note.text.length });
  }
  return found;
}

function orKeptNotes({ kept, paths }: { kept: KeptReads; paths: readonly string[] }) {
  return (error: unknown) => {
    if (error instanceof VaultUnreachableError) return keptNotes(kept, paths);
    throw error;
  };
}

/** Whether `path` is `under` or inside it. */
const within = (path: string, under: string) => path === under || path.startsWith(`${under}/`);

/** Every listing goes once the tree changed: which of them it changed is GitHub's to say next. */
const listings = (kind: CachedReadKind) => kind !== 'note';

function keptWrites({ fs, kept, connection }: CachedVaultFsDeps) {
  const online = (refusal = WRITE_NEEDS_CONNECTION) => {
    if (!connection.online()) throw new VaultUnreachableError(refusal);
  };
  const changedTree = (gone: readonly string[]) =>
    kept.forget((kind, asked) => listings(kind) || gone.some((path) => within(asked, path)));
  return {
    writeTextFile: async (args: Parameters<HostVaultFsPort['writeTextFile']>[0]) => {
      online();
      const ticket = kept.ticket();
      const modified = await fs.writeTextFile(args);
      void kept.keep('note', args.path, { text: args.contents, modified }, ticket);
      return modified;
    },
    createNote: async (args: Parameters<HostVaultFsPort['createNote']>[0]) => {
      online();
      const ticket = kept.ticket();
      const modified = await fs.createNote(args);
      void changedTree([]);
      void kept.keep('note', args.path, { text: args.contents, modified }, ticket);
      return modified;
    },
    createFolder: async (args: Parameters<HostVaultFsPort['createFolder']>[0]) => {
      online(NEW_FOLDER_NEEDS_CONNECTION);
      await fs.createFolder(args);
      void changedTree([]);
    },
    moveEntry: async (args: Parameters<HostVaultFsPort['moveEntry']>[0]) => {
      online();
      await fs.moveEntry(args);
      void changedTree([args.from, args.to]);
    },
    trashEntry: async (args: Parameters<HostVaultFsPort['trashEntry']>[0]) => {
      online();
      await fs.trashEntry(args);
      void changedTree([args.path]);
    },
    writeBinaryFile: async (args: Parameters<HostVaultFsPort['writeBinaryFile']>[0]) => {
      online();
      const length = await fs.writeBinaryFile(args);
      void changedTree([]);
      return length;
    },
  };
}

/**
 * Brings every kept note up to the tree's versions (#667), as the device
 * comes back online: a note changed elsewhere is read again, one gone is
 * forgotten, so the copy answered next time offline is the newest there was.
 * One listing of the tree, then only the notes that moved.
 */
export async function revalidateKeptNotes({
  fs,
  kept,
  connection,
}: CachedVaultFsDeps): Promise<void> {
  if (!connection.online()) return;
  const listed = await fs.listNotes({ skipDirectories: [], maxDepth: VAULT_WALK_DEPTH });
  const versions = new Map<string, number>(listed.map((note) => [note.path, note.modified]));
  for (const path of await kept.keysOf('note')) {
    const note = (await kept.kept('note', path, { peek: true })) as NoteContents | undefined;
    if (note === undefined || !isCachedNoteStale(note.modified, versions.get(path))) continue;
    if (versions.has(path)) {
      const ticket = kept.ticket();
      const fresh = await fs.readTextFile(path as VaultPath);
      void kept.keep('note', path, fresh, ticket);
    } else void kept.forget((kind, asked) => kind === 'note' && asked === path);
  }
}
