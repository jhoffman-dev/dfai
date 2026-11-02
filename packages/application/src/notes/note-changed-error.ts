import { isChangedOnDiskRefusal, isNoSuchEntry } from '../vault/ports.ts';

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
 * Whether a save of a note that was read was refused because the note moved
 * on since — changed, or gone (#665, attack on #745): the failures a
 * conflict copy is the answer to. Any other, a server's error or a dropped
 * connection, is a save to try again, and a copy of it would be a second
 * file for nothing. Gone counts only for such a save: the note was there
 * when it was opened, so nothing at its path now is someone deleting it.
 */
export function isStaleWriteRefusal(error: unknown): boolean {
  return error instanceof NoteChangedError || isChangedOnDiskRefusal(error) || isNoSuchEntry(error);
}
