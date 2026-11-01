import type { VaultPath } from '@dfai/domain';

/**
 * The notes a `[[` "Create" is making, the window over (#465): by the name
 * their file is given, folded, with where each landed once made — so a second
 * pane, a split, cannot make a second note of the same name before the
 * vault's list of notes has caught up with the first.
 */
export type NotesBeingMade = Map<string, VaultPath | null>;

export function createNotesBeingMade(): NotesBeingMade {
  return new Map();
}
