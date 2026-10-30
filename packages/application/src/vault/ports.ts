import type { EntryMove, VaultEntry, VaultPath } from '@dfai/domain';

/** Where the vault sits on the real filesystem. The UI never sees absolute paths. */
export interface VaultLocation {
  readonly absolutePath: string;
  readonly name: string;
}

/** A note in the vault, with what the index needs to spot a change. */
export interface NoteListing {
  readonly name: string;
  readonly path: VaultPath;
  readonly modified: number;
  readonly size: number;
}

export interface NoteFile {
  readonly path: string;
  readonly text: string;
  readonly modified: number;
  readonly size: number;
}

/** A note's text and the modification time it was read at. */
/** A file as it was read, for the host to hold a change to. */
export interface AsRead {
  readonly path: VaultPath;
  readonly modified: number;
  readonly text: string;
}

export interface NoteContents {
  readonly text: string;
  readonly modified: number;
}

export interface VaultFsPort {
  listDirectory(path: VaultPath): Promise<readonly VaultEntry[]>;
  /**
   * Every markdown note in the vault, with the file facts the index needs to tell
   * whether a note has changed.
   *
   * The host reports what is on disk and decides nothing about it. `skipDirectories`
   * names the folders it must not descend into — a list this layer owns and the
   * host merely obeys, so that a vault holding `node_modules` does not cost tens
   * of thousands of paths across IPC. Passing none walks the whole tree.
   * `maxDepth` is how many folders down it reads notes — the domain's
   * `VAULT_WALK_DEPTH`, handed over the same way, so nothing DFAI files is
   * deeper than the walk reads.
   */
  listNotes(options: {
    skipDirectories: readonly string[];
    maxDepth: number;
  }): Promise<readonly NoteListing[]>;
  /**
   * Every file in the vault whose name ends `.extension` (any case), in one
   * walk: what `[[name.pdf]]` is looked for among (#506). Told what to skip
   * and how deep to go as `listNotes` is. A link to a folder is not walked; a
   * folder that cannot be read is left out, the vault that cannot be read is
   * an error.
   */
  listFiles(options: {
    extension: string;
    skipDirectories: readonly string[];
    maxDepth: number;
  }): Promise<readonly VaultPath[]>;
  /** Reads many notes at once, so indexing is not thousands of round trips. */
  readNotes(paths: readonly string[]): Promise<readonly NoteFile[]>;
  readTextFile(path: VaultPath): Promise<NoteContents>;
  /** Raw bytes of a file in the vault, for showing an image. */
  readBinaryFile(path: VaultPath): Promise<ArrayBuffer>;
  /**
   * Creates a note and reports its modification time, as `writeTextFile` does
   * a save's. Fails rather than overwriting one that already exists.
   */
  createNote: (args: { path: VaultPath; contents: string }) => Promise<number>;
  /** Creates an empty folder. Fails if anything already has the name. */
  createFolder: (args: { path: VaultPath }) => Promise<void>;
  /**
   * Moves or renames a note or a folder. Fails rather than overwriting anything;
   * a folder cannot go inside itself.
   */
  moveEntry: (args: { from: VaultPath; to: VaultPath }) => Promise<void>;
  /**
   * Puts a note or a folder in the system Trash, where it can be recovered.
   * Fails rather than deleting it any other way.
   *
   * `unchanged` names files as they were read — the entry itself among them,
   * say. Given, the host checks each still has that modification time and
   * exactly that text, and trashes only then, in the same step; otherwise it
   * refuses with {@link EntryChangedError} and nothing moves (#235).
   */
  trashEntry: (args: { path: VaultPath; unchanged?: readonly AsRead[] }) => Promise<void>;
  /**
   * Replaces a note's contents and reports its new modification time.
   * `expectedModified` is the time the note was read at; the host refuses the
   * write if the file has changed since.
   *
   * `expectedText` is the note's whole text as that version was read. Given,
   * the host also refuses the write when the file no longer holds exactly
   * that, which the time alone cannot tell on a disk that keeps it to the
   * second (HFS+), to two (exFAT) or to a server's (SMB, NFS): another
   * program's write within the same tick leaves the time as it was (#245).
   */
  writeTextFile: (args: {
    path: VaultPath;
    contents: string;
    expectedModified: number | null;
    expectedText?: string;
  }) => Promise<number>;
  /**
   * Writes bytes into a file that is not a note — a file of an artifact's saved
   * copy. At `offset` 0 the file is created, failing rather than overwriting
   * anything; past 0 the bytes are added to the end of a file that must be
   * exactly `offset` bytes long, so a chunk sent twice or out of order is
   * refused instead of corrupting it. With `replace`, the file is written
   * whole instead, at offset 0, over one already there or as a new one — an
   * artifact's thumbnail, made again. Resolves to the file's new length.
   */
  writeBinaryFile: (args: {
    path: VaultPath;
    bytes: Uint8Array;
    offset: number;
    replace?: boolean;
  }) => Promise<number>;
}

/** What each write to the host carries besides its own arguments. */
interface MeantFor {
  /** The root of the vault the write is meant for. */
  readonly vault: string;
}

/** The writes of `VaultFsPort`, as the host takes them. */
type HostWrite<Write> = Write extends (args: infer Args) => infer Result
  ? (args: Args & MeantFor) => Result
  : never;

type VaultWrites =
  'createNote' | 'createFolder' | 'moveEntry' | 'trashEntry' | 'writeTextFile' | 'writeBinaryFile';

/**
 * The host's file commands, before they belong to a vault.
 *
 * The host holds one open vault and resolves paths against it, so every write
 * names the vault it is meant for and is refused once that is not the open one
 * (R14-01). The name is required, not optional (R14-04): this is not a
 * `VaultFsPort` — the writes are properties, so the compiler compares them
 * strictly — and the only ways to one are `inVault`, which says which vault,
 * and `noVaultOpen`, which writes nothing.
 */
export type HostVaultFsPort = Omit<VaultFsPort, VaultWrites> & {
  readonly [Write in VaultWrites]: HostWrite<VaultFsPort[Write]>;
};

/**
 * The editors open in the app's panes, as moving or deleting a note has to
 * reach them.
 *
 * A pane holds a note by its path, its unsaved typing and the modification time
 * it read. Moving the file under it without telling it leaves it saving to a
 * path that is gone; deleting the file leaves its save on the way out with
 * nowhere to land. The desktop app answers with its pane registry.
 */
export interface OpenEditorsPort {
  /** `dirty` when any pane holding the note has unsaved edits. */
  state(path: VaultPath): 'closed' | 'clean' | 'dirty';
  /** Writes the unsaved edits of every pane holding one of these notes; settles once each has landed or been refused. */
  flush(paths: readonly VaultPath[]): Promise<void>;
  /**
   * Re-points every pane holding a moved note at where it went, keeping what is
   * on screen — the document, unsaved typing and all — rather than reading it again.
   */
  follow(move: EntryMove): void;
  /** Lets go of the unsaved edits of panes holding notes that are gone, so nothing tries to save them. */
  abandon(paths: readonly VaultPath[]): void;
  /**
   * Every note a pane holds unsaved typing in. Optional: only the app has
   * panes to list; a port without it is read as having none to save.
   */
  dirtyPaths?(): readonly VaultPath[];
}

/** Asking the user which folder is their vault, via the host's native picker. */
export interface VaultPickerPort {
  pickDirectory(): Promise<VaultLocation | null>;
}

/** Remembering the choice between launches. */
export interface VaultLocationStore {
  read(): Promise<VaultLocation | null>;
  write(location: VaultLocation): Promise<void>;
}

/**
 * A refusal from the host: no vault open, entry missing, path escaping the vault,
 * file too large, not text. Adapters wrap whatever the host sends in this, so
 * callers always catch an Error rather than a bare string from an IPC boundary.
 */
export class VaultAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultAccessError';
  }
}

/** The host refused to act on an entry: a file it was told was as read had changed since (#235). */
export class EntryChangedError extends VaultAccessError {
  constructor(message: string) {
    super(message);
    this.name = 'EntryChangedError';
  }
}

/**
 * Notices changes made to the vault by anything other than this app.
 * Reports paths only; what to do about them is decided by the caller.
 */
export interface VaultWatchPort {
  start(): Promise<void>;
  /** Subscribes to changes and resolves to a function that stops listening. */
  onChange(handler: (paths: readonly string[]) => void): Promise<() => void>;
}
