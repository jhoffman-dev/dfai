import { isChangedOnDiskRefusal } from '../vault/ports.ts';

/**
 * A write refused because the note is no longer the one the caller read.
 *
 * Raised before anything is written, when the caller said which modification
 * time it read the note at and the note on disk now has another.
 */
export class NoteChangedError extends Error {
  constructor(path: string) {
    super(`${path} changed since it was read`);
    this.name = 'NoteChangedError';
  }
}

/**
 * Whether a write was refused because the note moved on since it was read —
 * the one failure a conflict copy is the answer to (#665). Any other, a
 * server's error or a dropped connection, is a save to try again, and a copy
 * of it would be a second file for nothing.
 */
export function isStaleWriteRefusal(error: unknown): boolean {
  return error instanceof NoteChangedError || isChangedOnDiskRefusal(error);
}
