import { useState } from 'react';
import { createVaultPath, movedPath, type EntryMove } from '@dfai/domain';

/**
 * What each note's status was before its box was ticked, for as long as the
 * app is open — so unticking a task put in review goes back to review rather
 * than to the start. Kept in memory only: it is a convenience, not a fact
 * about the note, and the file never hears of it. One is made per vault, so a
 * path in one vault never recalls what a note at the same path in another held.
 */
export interface TickMemory {
  remember(args: { path: string; value: string }): void;
  /** The status before the tick, or null when this session did not see one. */
  recall(path: string): string | null;
  /** Carries what was remembered along with a note or folder that moved. */
  follow(move: EntryMove): void;
}

export function createTickMemory(): TickMemory {
  const before = new Map<string, string>();
  return {
    remember: ({ path, value }) => before.set(path, value),
    recall: (path) => before.get(path) ?? null,
    follow: (move) => {
      for (const [path, value] of [...before]) {
        const to = movedPath(createVaultPath(path), move);
        if (to === null) continue;
        before.delete(path);
        before.set(to, value);
      }
    },
  };
}

/**
 * One memory for the vault open, shared by both panes: unticking in either puts
 * back what was ticked in the other. Another vault opened starts a fresh one.
 */
export function useTickMemory(vault: string | null): TickMemory {
  const [held, setHeld] = useState(() => ({ vault, memory: createTickMemory() }));
  if (held.vault === vault) return held.memory;
  const fresh = { vault, memory: createTickMemory() };
  setHeld(fresh);
  return fresh.memory;
}
