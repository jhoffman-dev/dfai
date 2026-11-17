/*
 * A note's writes, one at a time (#880). Each write reads the note and writes
 * it back against the version it read, so two at once would both read the
 * same version and the host would refuse the second as stale. Waiting its
 * turn, the second reads what the first wrote. Writes to different notes do
 * not wait on each other, and a note with nothing in flight holds no entry.
 */

export interface NoteWriteTurns {
  /** Runs `write` once every write to `note` taken before it has settled; answers what it answers. */
  take<T>(note: string, write: () => Promise<T>): Promise<T>;
  /** Whether a write to `note` is running or waiting. */
  busy(note: string): boolean;
}

export function noteWriteTurns(): NoteWriteTurns {
  const lastOf = new Map<string, Promise<unknown>>();
  return {
    take(note, write) {
      const before = lastOf.get(note) ?? Promise.resolve();
      // The one before failing is its own caller's to hear; this one runs regardless.
      const turn = before.catch(() => undefined).then(write);
      lastOf.set(note, turn);
      const forget = () => {
        if (lastOf.get(note) === turn) lastOf.delete(note);
      };
      turn.then(forget, forget);
      return turn;
    },
    busy: (note) => lastOf.has(note),
  };
}
