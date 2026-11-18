import type { VaultPath } from '@dfai/domain';
import type { ArchivePorts } from '../archive/archive-notes.ts';

/**
 * The ports, with the last text each note was written with remembered: what
 * a write itself left, not the disk read back, so an undo refuses an edit
 * saved since rather than taking it for what was written.
 */
export function recordingWrites(ports: ArchivePorts): {
  ports: ArchivePorts;
  written: ReadonlyMap<VaultPath, string>;
} {
  const written = new Map<VaultPath, string>();
  const writeTextFile: ArchivePorts['fs']['writeTextFile'] = async (write) => {
    const modified = await ports.fs.writeTextFile(write);
    written.set(write.path, write.contents);
    return modified;
  };
  return { ports: { ...ports, fs: { ...ports.fs, writeTextFile } }, written };
}
