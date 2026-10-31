import type { OwnWrites } from './own-writes.ts';
import type { VaultFsPort } from './ports.ts';

/**
 * The vault, with every write it makes kept in `ownWrites` as what it left
 * behind, so the watcher's report of it can be known as the app's own
 * (#254). A new note is kept as a save is, by the time the host reports for
 * it (#258). A write whose result the host does not report in full — an
 * artifact's bytes — and a write that fails are forgotten instead: what is
 * there is not known, so a report of it is refreshed for. A refused new note
 * is the exception: it changed nothing.
 */
export function recordingOwnWrites({
  fs,
  ownWrites,
  vault,
}: {
  fs: VaultFsPort;
  ownWrites: OwnWrites;
  vault: string;
}): VaultFsPort {
  const at = (path: string) => ({ vault, path });
  /** Runs a write; whatever it fails on is forgotten at every path it named, then thrown on. */
  const forgetOnFailure = async <T>(paths: readonly string[], write: () => Promise<T>) => {
    try {
      return await write();
    } catch (error) {
      for (const path of paths) ownWrites.forget(at(path));
      throw error;
    }
  };
  /** Keeps a note's new text as what `write` left, at the time the host reports for it. */
  const leavingText = async (
    { path, contents }: { path: string; contents: string },
    write: Promise<number>,
  ) => {
    const modified = await write;
    ownWrites.record({ ...at(path), left: { kind: 'text', text: contents, modified } });
    return modified;
  };
  const forgetAfter = async <T>(path: string, write: () => Promise<T>) => {
    try {
      return await write();
    } finally {
      ownWrites.forget(at(path));
    }
  };
  return {
    listDirectory: (path) => fs.listDirectory(path),
    listNotes: (options) => fs.listNotes(options),
    listFiles: (options) => fs.listFiles(options),
    readNotes: (paths) => fs.readNotes(paths),
    readTextFile: (path) => fs.readTextFile(path),
    readBinaryFile: (path) => fs.readBinaryFile(path),
    writeTextFile: (args) =>
      forgetOnFailure([args.path], () => leavingText(args, fs.writeTextFile(args))),
    // Not forgotten when it fails: the host makes a note by renaming it into
    // place only if nothing is there, so a refused create left the path as it
    // was. Forgetting dropped the record of the app's own create that the
    // refusal ran into, and that create's echo was then walked for.
    createNote: (args) => leavingText(args, fs.createNote(args)),
    createFolder: (args) =>
      forgetOnFailure([args.path], async () => {
        await fs.createFolder(args);
        ownWrites.record({ ...at(args.path), left: { kind: 'folder' } });
      }),
    trashEntry: (args) =>
      forgetOnFailure([args.path], async () => {
        await fs.trashEntry(args);
        // A folder goes with all it holds: what the app left inside is gone too.
        ownWrites.forgetUnder(at(args.path));
        ownWrites.record({ ...at(args.path), left: { kind: 'absent' } });
      }),
    moveEntry: (args) =>
      forgetOnFailure([args.from, args.to], async () => {
        await fs.moveEntry(args);
        // A note moves with its bytes and its time; anything else moved is not known.
        const carried = ownWrites.leftAt(at(args.from));
        if (carried?.kind === 'text') ownWrites.record({ ...at(args.to), left: carried });
        else ownWrites.forget(at(args.to));
        // A folder moves with all it holds, so neither end's contents are known.
        ownWrites.forgetUnder(at(args.from));
        ownWrites.forgetUnder(at(args.to));
        ownWrites.record({ ...at(args.from), left: { kind: 'absent' } });
      }),
    writeBinaryFile: (args) => forgetAfter(args.path, () => fs.writeBinaryFile(args)),
  };
}
