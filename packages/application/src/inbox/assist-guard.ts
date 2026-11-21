import { noteTitle, type AssistIntent, type VaultPath } from '@dfai/domain';
import type { ArchivePorts } from '../archive/archive-notes.ts';
import type { AsRead, VaultFsPort } from '../vault/ports.ts';

/**
 * The one path every vault write of Inbox assist goes through (#911): an
 * apply, the rollback of one that failed, and an undo. The use-cases it
 * calls — clarifying, filing, archiving, adding a person, moving back — are
 * handed these ports and nothing else, so no write of theirs escapes it.
 *
 * Each write, before it is made:
 *
 * 1. logs what it is about to do (`mark`), and waits for the log;
 * 2. is held to the exact text the row knows the note says — the text it
 *    first read of it, or last wrote into it itself: the note is read again,
 *    and any other text is refused before anything is written; a save also
 *    carries that text to the host, which refuses it as well if it changed in
 *    between (within the disk's timestamp tick too). A note the row has never
 *    read is not written at all. A create is exclusive; a move and a trash
 *    are held to their source's text, read just before. The guard only ever
 *    adds to the checks a write asks for: a save keeps the time its caller
 *    read the note at, and a trash every note its caller held it to.
 * 3. is recorded (`written`): each note's text before the row first wrote
 *    it, and after its last write; each note made; where each note moved.
 *
 * Typing a pane has not saved is never saved from here: that would be a
 * write nobody checked. A path in `forbidden` (a duplicate's kept task) is
 * never written.
 */
export interface GuardedWrites {
  readonly ports: ArchivePorts;
  /** Each note the row wrote, with its text before the first write and after the last. */
  readonly rewrites: () => readonly { path: VaultPath; before: string; after: string }[];
  /** Each note the row made, as made. */
  readonly made: () => readonly AsRead[];
  /** What the row knows a note says now, by path; undefined for a note it never read. */
  readonly knows: (path: VaultPath) => string | undefined;
}

/** A write the guard would not make, and why, in the person's words. */
export class GuardRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardRefusedError';
  }
}

/**
 * What the guard does with each method of the vault port: passes a read
 * through, guards a write, or refuses it. A method added to the port does not
 * compile until it is placed here — and the tests' list of writes is this.
 */
export const VAULT_FS_METHODS = {
  listDirectory: 'read',
  listNotes: 'read',
  listFiles: 'read',
  readNotes: 'read',
  readTextFile: 'read',
  readBinaryFile: 'read',
  createNote: 'write',
  createFolder: 'write',
  moveEntry: 'write',
  trashEntry: 'write',
  writeTextFile: 'write',
  writeBinaryFile: 'refused',
} as const satisfies { readonly [K in keyof VaultFsPort]-?: 'read' | 'write' | 'refused' };

/** Every port a write could go through, typed so a new one does not compile until it is placed. */
type Placed<T> = { readonly [K in keyof T]-?: T[K] };

export interface GuardOptions {
  /** What the row has checked each note says already, by path. */
  readonly known: ReadonlyMap<VaultPath, string>;
  /** Where the item is, as the row's own moves take it: a write there is the item's, not a relink. */
  readonly items: Set<VaultPath>;
  readonly forbidden?: ReadonlySet<VaultPath>;
  /** Logs what is about to be done; rejects when the log cannot be written, and then nothing is. */
  readonly mark: (intent: AssistIntent) => Promise<void>;
  /** Logs a note just made, with what it says: a crash right after is known to have made it. */
  readonly madeIt?: (made: AsRead) => Promise<void>;
}

/** What the guard keeps for one row: what it knows each note says, and what it wrote. */
interface Kept {
  readonly known: Map<VaultPath, string>;
  readonly before: Map<VaultPath, string>;
  readonly written: Map<VaultPath, string>;
  readonly made: AsRead[];
}

export function guardedWrites(ports: ArchivePorts, options: GuardOptions): GuardedWrites {
  const record: Kept = {
    known: new Map(options.known),
    before: new Map(),
    written: new Map(),
    made: [],
  };
  const fs = guardedFs(ports.fs, options, record);
  const { editors: inner } = ports;
  const editors = {
    state: (path) => inner.state(path),
    // Nothing to save is no write, and passes; typing not saved is never saved from here.
    flush: async (paths) => {
      if (paths.some((path) => inner.state(path) === 'dirty')) {
        throw new GuardRefusedError('It has typing not saved yet, so it was left as it is.');
      }
    },
    // Panes only: where a moved note is shown, and reading a saved one again. No note is written.
    follow: (move) => inner.follow(move),
    abandon: (paths) => inner.abandon(paths),
    reload: (path) => inner.reload(path),
    dirtyPaths: () => inner.dirtyPaths?.() ?? [],
  } satisfies Placed<ArchivePorts['editors']>;
  // The index is derived from the notes and disposable; markdown is pure. Neither writes a note.
  const guarded = {
    fs,
    editors,
    index: ports.index,
    markdown: ports.markdown,
  } satisfies Placed<ArchivePorts>;
  return {
    ports: guarded,
    rewrites: () =>
      [...record.written].map(([path, after]) => ({
        path,
        before: record.before.get(path)!,
        after,
      })),
    made: () => [...record.made],
    knows: (path) => record.known.get(path),
  };
}

/**
 * The vault as Inbox assist's modules hold it (#911): `reads` refuses every
 * write before it is made, and `guard` makes the one way to write for a row
 * or an undo. The raw ports go to `guardedWrites` alone, here.
 */
export interface AssistVault {
  readonly reads: ArchivePorts;
  readonly guard: (options: GuardOptions) => GuardedWrites;
}

export function assistVault(ports: ArchivePorts): AssistVault {
  const readOnly = guardedWrites(ports, {
    known: new Map(),
    items: new Set(),
    mark: async () => {
      throw new GuardRefusedError('Inbox assist writes nothing here: it only reads.');
    },
  });
  return { reads: readOnly.ports, guard: (options) => guardedWrites(ports, options) };
}

function guardedFs(inner: VaultFsPort, options: GuardOptions, record: Kept): VaultFsPort {
  const { items, forbidden = new Set(), mark, madeIt = async () => undefined } = options;
  const { known, before, written, made } = record;
  const learn = (path: VaultPath, text: string) => {
    if (!known.has(path)) known.set(path, text);
  };
  /** The note read again, refused unless it says exactly what the row knows. */
  const held = async (path: VaultPath): Promise<{ text: string; modified: number }> => {
    if (forbidden.has(path))
      throw new GuardRefusedError(`${noteTitle(path)} is never written by this row.`);
    const expected = known.get(path);
    if (expected === undefined) {
      throw new GuardRefusedError(`${noteTitle(path)} was not read first, so it was not written.`);
    }
    const now = await inner.readTextFile(path);
    if (now.text !== expected) throw changedWhileWritten(path);
    return now;
  };
  const fs = {
    listDirectory: (path) => inner.listDirectory(path),
    listNotes: (scan) => inner.listNotes(scan),
    listFiles: (scan) => inner.listFiles(scan),
    readBinaryFile: (path) => inner.readBinaryFile(path),
    readTextFile: async (path) => {
      const read = await inner.readTextFile(path);
      learn(path, read.text);
      return read;
    },
    readNotes: async (paths) => {
      const read = await inner.readNotes(paths);
      for (const note of read) learn(note.path as VaultPath, note.text);
      return read;
    },
    writeTextFile: async (write) => {
      await mark({ doing: items.has(write.path) ? 'write' : 'relink', path: write.path });
      const now = await held(write.path);
      // The caller's own check stands: a text it read that is not what is there now is refused.
      if (write.expectedText !== undefined && write.expectedText !== now.text) {
        throw changedWhileWritten(write.path);
      }
      const modified = await inner.writeTextFile({
        path: write.path,
        contents: write.contents,
        // The time the caller read the note at, when it gave one: never replaced by a later read.
        expectedModified: write.expectedModified ?? now.modified,
        expectedText: now.text,
      });
      if (!before.has(write.path)) before.set(write.path, now.text);
      known.set(write.path, write.contents);
      written.set(write.path, write.contents);
      return modified;
    },
    createNote: async (create) => {
      await mark({ doing: 'create', path: create.path });
      // Exclusive: the host refuses a note that is already there.
      const modified = await inner.createNote(create);
      known.set(create.path, create.contents);
      const note = { path: create.path, modified, text: create.contents };
      made.push(note);
      await madeIt(note);
      return modified;
    },
    createFolder: async (folder) => {
      await mark({ doing: 'folder', path: folder.path });
      // Exclusive too: refused when anything has the name.
      await inner.createFolder(folder);
    },
    moveEntry: async (move) => {
      await mark({ doing: 'move', path: move.from, to: move.to });
      const now = await held(move.from);
      await inner.moveEntry(move);
      known.delete(move.from);
      known.set(move.to, now.text);
      if (items.has(move.from)) items.add(move.to);
      for (const map of [before, written]) {
        const text = map.get(move.from);
        if (text === undefined) continue;
        map.delete(move.from);
        map.set(move.to, text);
      }
    },
    trashEntry: async (trash) => {
      await mark({ doing: 'trash', path: trash.path });
      const now = await held(trash.path);
      // Every note the caller held it to, and this one as the row knows it.
      const unchanged = [...(trash.unchanged ?? []), { path: trash.path, ...now }];
      await inner.trashEntry({ path: trash.path, unchanged });
      known.delete(trash.path);
    },
    writeBinaryFile: async ({ path }) => {
      throw new GuardRefusedError(
        `${noteTitle(path)} is not a note: Inbox assist writes notes alone.`,
      );
    },
  } satisfies Placed<VaultFsPort>;
  return fs;
}

const changedWhileWritten = (path: VaultPath) =>
  new GuardRefusedError(
    `${noteTitle(path)} changed while the row was being written, so it was left as it is.`,
  );
