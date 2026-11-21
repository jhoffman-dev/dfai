import { noteTitle, type AssistIntent, type VaultPath } from '@dfai/domain';
import type { ArchivePorts } from '../archive/archive-notes.ts';
import type { AsRead } from '../vault/ports.ts';

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
 *    are held to their source's text, read just before.
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

export function guardedWrites(
  ports: ArchivePorts,
  {
    known: seeded,
    items,
    forbidden = new Set(),
    mark,
    madeIt = async () => undefined,
  }: {
    /** What the row has checked each note says already, by path. */
    known: ReadonlyMap<VaultPath, string>;
    /** Where the item is, as the row's own moves take it: a write there is the item's, not a relink. */
    items: Set<VaultPath>;
    forbidden?: ReadonlySet<VaultPath>;
    /** Logs what is about to be done; rejects when the log cannot be written, and then nothing is. */
    mark: (intent: AssistIntent) => Promise<void>;
    /** Logs a note just made, with what it says: a crash right after is known to have made it. */
    madeIt?: (made: AsRead) => Promise<void>;
  },
): GuardedWrites {
  const inner = ports.fs;
  const known = new Map(seeded);
  const before = new Map<VaultPath, string>();
  const written = new Map<VaultPath, string>();
  const made: AsRead[] = [];
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
    if (now.text !== expected) {
      throw new GuardRefusedError(
        `${noteTitle(path)} changed while the row was being written, so it was left as it is.`,
      );
    }
    return now;
  };
  const fs: ArchivePorts['fs'] = {
    ...inner,
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
      const modified = await inner.writeTextFile({
        path: write.path,
        contents: write.contents,
        expectedModified: now.modified,
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
      await inner.trashEntry({ path: trash.path, unchanged: [{ path: trash.path, ...now }] });
      known.delete(trash.path);
    },
    writeBinaryFile: async ({ path }) => {
      throw new GuardRefusedError(
        `${noteTitle(path)} is not a note: Inbox assist writes notes alone.`,
      );
    },
  };
  const editors: ArchivePorts['editors'] = {
    ...ports.editors,
    // Nothing to save is no write, and passes; typing not saved is never saved from here.
    flush: async (paths) => {
      if (paths.some((path) => ports.editors.state(path) === 'dirty')) {
        throw new GuardRefusedError('It has typing not saved yet, so it was left as it is.');
      }
    },
  };
  return {
    ports: { ...ports, fs, editors },
    rewrites: () =>
      [...written].map(([path, after]) => ({ path, before: before.get(path)!, after })),
    made: () => [...made],
    knows: (path) => known.get(path),
  };
}
