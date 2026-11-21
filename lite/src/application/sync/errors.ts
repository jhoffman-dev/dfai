/**
 * The branch synced before is not on GitHub now: renamed, deleted, or the
 * branch setting changed. Nothing is inferred from its absence.
 */
export class RemoteBranchMissingError extends Error {
  override readonly name = 'RemoteBranchMissingError';
  constructor(message = 'The branch this vault syncs with is no longer on GitHub.') {
    super(message);
  }
}

/**
 * This device last synced with another repository or branch. Its files'
 * bases belong to that one, so comparing them with this one would read as
 * every note deleted or changed.
 */
export class RemoteChangedError extends Error {
  override readonly name = 'RemoteChangedError';
  constructor(
    message = 'This device last synced with another repository or branch; open that vault afresh.',
  ) {
    super(message);
  }
}
