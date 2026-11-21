import type { VaultPath } from '../../domain/vault/index.ts';
import type { Clock, NoteStore, RemoteVault } from '../ports/index.ts';
import type { VaultSession } from '../session/index.ts';

/** A file's path and text, as derived files are made from and of. */
export interface PathText {
  readonly path: VaultPath;
  readonly text: string;
}

/**
 * Git's name for a blob holding `text` as UTF-8 (WebCrypto SHA-1 over
 * `blob <len>\0<bytes>` in the app). Equal texts, equal names: it is how a
 * local text is compared with a remote sha without fetching the blob.
 */
export type BlobHasher = (text: string) => Promise<string>;

/** The files generated from the notes (`_index/*.md`): same notes, same files. */
export type DerivedFiles = (notes: readonly PathText[]) => readonly PathText[];

/** What sync needs. */
export interface SyncDeps {
  readonly store: NoteStore;
  readonly remote: RemoteVault;
  readonly session: VaultSession;
  /** Dates conflict copies. */
  readonly clock: Clock;
  /**
   * Which repository and branch `remote` is, e.g. `owner/repo@branch`. What
   * was last seen is kept with it, and sync refuses to compare this device's
   * files with a remote other than the one they were synced with.
   */
  readonly remoteIdentity: string;
  /** Must name blobs exactly as `remote` does. */
  readonly hashBlob: BlobHasher;
  /** When given, the generated `_index/` files are kept in step with the notes on every push. */
  readonly derivedFiles?: DerivedFiles;
}

/** A note both sides changed: the remote version stayed at `path`, this device's went to `copy`. */
export interface SyncConflict {
  readonly path: VaultPath;
  readonly copy: VaultPath;
}

/**
 * Why a sync stopped. Nothing was lost: what was not pushed is still dirty
 * here. `moved`: the branch kept moving under every retry.
 * `branch-missing`: the branch synced before is gone from GitHub.
 * `remote-changed`: this device last synced with another repository or
 * branch. `error`: anything else (GitHub answered something unreadable, say).
 */
export type SyncFailure =
  'auth' | 'unreachable' | 'moved' | 'branch-missing' | 'remote-changed' | 'error';

export type SyncResult =
  | {
      readonly kind: 'synced';
      /** Files written or deleted here from the remote. */
      readonly pulled: number;
      /** Files sent, or deleted, in the one commit pushed (0 when there was nothing to push). */
      readonly pushed: number;
      readonly conflicts: readonly SyncConflict[];
      /** The branch's head after the sync; null for an empty repository with nothing pushed. */
      readonly headSha: string | null;
    }
  | { readonly kind: 'failed'; readonly reason: SyncFailure; readonly message: string };

/**
 * One round of sync with the remote: pull, then push. Made by
 * `createSyncNow(deps)`; the scheduler decides when to call it, and never
 * runs two at once.
 */
export type SyncNow = () => Promise<SyncResult>;
