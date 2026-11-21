import type { VaultPath } from '../../domain/vault/index.ts';

/** Where the branch is: its head commit and that commit's root tree. */
export interface RemoteHead {
  readonly commitSha: string;
  readonly treeSha: string;
}

/** One file in a remote tree: its path and its git blob sha. */
export interface RemoteEntry {
  readonly path: VaultPath;
  readonly sha: string;
}

/** One commit to push: every change since `parentCommitSha`, together. */
export interface PushCommit {
  readonly message: string;
  readonly upserts: readonly { readonly path: VaultPath; readonly text: string }[];
  readonly deletes: readonly VaultPath[];
  /** The head this commit was built on. If the branch has moved, the push fails. */
  readonly parentCommitSha: string;
}

/**
 * The vault's GitHub repository, on one branch (the Git Data API in the app).
 *
 * Every method can fail with {@link RemoteAuthError} (the token is missing,
 * wrong or lacks access) or {@link RemoteUnreachableError} (offline, timed
 * out, GitHub down). The adapter translates; it never retries a push itself
 * and never forces one.
 */
export interface RemoteVault {
  /** The branch's head now. */
  head(): Promise<RemoteHead>;
  /** Every file under a tree, recursively, sorted by path. Folders are not listed. */
  tree(treeSha: string): Promise<RemoteEntry[]>;
  /** The texts of blobs, by sha, fetched in as few requests as it can. Every sha asked for is in the map. */
  blobs(shas: readonly string[]): Promise<Map<string, string>>;
  /**
   * Commits the changes on top of `parentCommitSha` and fast-forwards the
   * branch to it. Fails with {@link RemoteMovedError} when the branch is no
   * longer at the parent: the caller pulls, settles, and pushes again.
   * Returns the branch's new head.
   */
  push(commit: PushCommit): Promise<RemoteHead>;
}

/** The branch moved since the push's parent: someone else pushed first. */
export class RemoteMovedError extends Error {
  override readonly name = 'RemoteMovedError';
  constructor(message = 'The branch moved since the last pull.') {
    super(message);
  }
}

/** The token was refused. The message never holds the token. */
export class RemoteAuthError extends Error {
  override readonly name = 'RemoteAuthError';
  constructor(message = 'GitHub refused the token.') {
    super(message);
  }
}

/** GitHub could not be reached, or did not answer in time. */
export class RemoteUnreachableError extends Error {
  override readonly name = 'RemoteUnreachableError';
  constructor(message = 'GitHub could not be reached.') {
    super(message);
  }
}
