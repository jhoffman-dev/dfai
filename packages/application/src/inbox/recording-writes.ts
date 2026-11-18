import type { VaultPath } from '@dfai/domain';
import type { ArchivePorts } from '../archive/archive-notes.ts';

/** One note a write changed: its text before the first write, and after the last. */
export interface Rewritten {
  readonly path: VaultPath;
  /** What it said when it was read for the first write; null when no read of it was seen. */
  readonly before: string | null;
  readonly after: string;
}

/**
 * The ports, with the last text each note was written with remembered: what
 * a write itself left, not the disk read back, so an undo refuses an edit
 * saved since rather than taking it for what was written. Each note written
 * is also kept with the text it said before (#911): the text the write was
 * held to, or the last read of it, which every writer here makes just before
 * it writes. Reads pass through unchanged; no host call is added.
 */
export function recordingWrites(ports: ArchivePorts): {
  ports: ArchivePorts;
  written: ReadonlyMap<VaultPath, string>;
  rewritten: () => readonly Rewritten[];
} {
  const written = new Map<VaultPath, string>();
  const lastRead = new Map<VaultPath, string>();
  const firstBefore = new Map<VaultPath, string | null>();
  const readTextFile: ArchivePorts['fs']['readTextFile'] = async (path) => {
    const read = await ports.fs.readTextFile(path);
    lastRead.set(path, read.text);
    return read;
  };
  const writeTextFile: ArchivePorts['fs']['writeTextFile'] = async (write) => {
    const before = write.expectedText ?? lastRead.get(write.path) ?? null;
    const modified = await ports.fs.writeTextFile(write);
    if (!firstBefore.has(write.path)) firstBefore.set(write.path, before);
    written.set(write.path, write.contents);
    lastRead.set(write.path, write.contents);
    return modified;
  };
  const rewritten = () =>
    [...written].map(([path, after]) => ({ path, before: firstBefore.get(path) ?? null, after }));
  return {
    ports: { ...ports, fs: { ...ports.fs, readTextFile, writeTextFile } },
    written,
    rewritten,
  };
}
