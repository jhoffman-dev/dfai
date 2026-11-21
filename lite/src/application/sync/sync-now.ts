import type { VaultPath } from '../../domain/vault/index.ts';
import type { Clock, NoteStore, RemoteVault } from '../ports/index.ts';
import type { VaultSession } from '../session/index.ts';

/** What one sync needs. */
export interface SyncDeps {
  readonly store: NoteStore;
  readonly remote: RemoteVault;
  readonly session: VaultSession;
  /** Dates conflict copies. */
  readonly clock: Clock;
}

/** A note both sides changed: the remote version stayed at `path`, this device's went to `copy`. */
export interface SyncConflict {
  readonly path: VaultPath;
  readonly copy: VaultPath;
}

/** Why a sync stopped. Nothing was lost: what was not pushed is still dirty here. */
export type SyncFailure = 'auth' | 'unreachable' | 'moved';

export type SyncResult =
  | {
      readonly kind: 'synced';
      /** Files written or deleted here from the remote. */
      readonly pulled: number;
      /** Files sent, or deleted, in the one commit pushed (0 when there was nothing to push). */
      readonly pushed: number;
      readonly conflicts: readonly SyncConflict[];
      /** The branch's head after the sync. */
      readonly headSha: string;
    }
  | { readonly kind: 'failed'; readonly reason: SyncFailure; readonly message: string };

/**
 * Pull, then push: one round of sync with the remote.
 *
 * 1. Read the head; if its tree differs from the last one seen (kept in the
 *    store's state), read the tree and fetch only blobs that changed.
 * 2. For each path, decide with the domain's `decideSync` over
 *    `{ base, local, remote }`: base is the sha last seen for the path (its
 *    `baseSha`, or the last tree's entry when the file was deleted here);
 *    local is the base when the file is not dirty, a marker unique to its
 *    text when it is, and null when it is gone; remote is the new tree's sha.
 * 3. Apply pulls to the store and session; a conflict keeps the remote text
 *    at the path and this device's at `conflictCopyPath` (dated by `clock`).
 * 4. Push everything dirty and every delete as one commit on the head read
 *    in step 1. On `RemoteMovedError`, start again from step 1; never force.
 * 5. Mark pushed files clean with their new shas and record the tree seen.
 *
 * Implemented in this folder (`src/application/sync/`) by the sync work.
 */
export type SyncNow = (deps: SyncDeps) => Promise<SyncResult>;
