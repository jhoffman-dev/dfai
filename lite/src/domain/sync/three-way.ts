/**
 * A file's version, by any identity that is equal exactly when the contents
 * are (a git blob sha, say); null when the file does not exist on that side.
 */
export type BlobId = string | null;

/** One path's three versions: at the last sync, here now, and on the remote now. */
export interface ThreeWay {
  readonly base: BlobId;
  readonly local: BlobId;
  readonly remote: BlobId;
}

/**
 * What a sync does with one path:
 *
 * - `unchanged`: nothing to move. Both sides may have made the same change,
 *   so the caller records the remote version as the new base.
 * - `take-remote`: write the remote version here (only the remote changed,
 *   or the remote edited what this device deleted).
 * - `delete-local`: the remote deleted it and this device did not change it.
 * - `push-local`: send this device's version (only it changed, or it edited
 *   what the remote deleted).
 * - `push-delete`: this device deleted it and the remote did not change it.
 * - `conflict`: both sides changed it differently. The remote version stays
 *   at the path and this device's goes to a conflict copy beside it.
 *
 * A delete never beats an edit: the edit wins, so no typed text is lost.
 */
export type SyncDecision =
  'unchanged' | 'take-remote' | 'delete-local' | 'push-local' | 'push-delete' | 'conflict';

export function decideSync({ base, local, remote }: ThreeWay): SyncDecision {
  if (local === remote) return 'unchanged';
  if (local === base) return remote === null ? 'delete-local' : 'take-remote';
  if (remote === base) return local === null ? 'push-delete' : 'push-local';
  if (local === null) return 'take-remote';
  if (remote === null) return 'push-local';
  return 'conflict';
}
