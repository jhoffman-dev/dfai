import { VaultAccessError } from '@dfai/application';
import { base64ToBytes, bytesToBase64, gitBlobSha } from './git-bytes.ts';
import {
  readBlobBase64,
  readCreatedSha,
  readRefSha,
  readTree,
  type GitTreeListing,
} from './github-answers.ts';
import { GITHUB_MALFORMED, GitHubRefusedError, type GitHubApi } from './github-api.ts';

/**
 * One branch of one repository through the Git Data API (#664): its head,
 * the tree at a commit, a blob's bytes, and a commit made on it. A commit
 * moves the branch only as a fast-forward of the head it was made on
 * (`force: false`), so a head that moved meanwhile is refused, never forced.
 */

/** The vault's repository and the branch its notes are on. */
export interface GitHubVaultRepository {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
}

/** A change to one path of the tree: a blob put there, or (`sha: null`) the path taken away. */
export interface TreeChange {
  readonly path: string;
  readonly mode: string;
  readonly type: 'blob';
  readonly sha: string | null;
}

export interface CommitAsked {
  /** The commit the change was decided against; the branch must still be there. */
  readonly head: string;
  /** That commit's tree. */
  readonly tree: string;
  readonly changes: readonly TreeChange[];
  readonly message: string;
  /** What the write is refused with when the branch has moved past `head`. */
  readonly moved: () => Error;
}

export interface GitBranch {
  head(): Promise<string>;
  listing(commit: string): Promise<GitTreeListing>;
  blob(sha: string): Promise<Uint8Array>;
  /** Stores bytes as a blob and answers its sha, checked to be git's name for exactly those bytes. */
  upload(bytes: Uint8Array): Promise<string>;
  /** Commits the changes on `head` and moves the branch to it, as a fast-forward only. */
  commit(asked: CommitAsked): Promise<string>;
}

/** The refs path segment by segment, so a branch like `notes/main` stays one ref. */
const encoded = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');

export function gitBranch(api: GitHubApi, where: GitHubVaultRepository): GitBranch {
  const repo = `/repos/${encodeURIComponent(where.owner)}/${encodeURIComponent(where.repo)}`;
  const ref = `heads/${encoded(where.branch)}`;
  return {
    head: () => headOf(api, `${repo}/git/ref/${ref}`),
    listing: async (commit) => {
      const listing = readTree(
        await api.send({ method: 'GET', path: `${repo}/git/trees/${commit}?recursive=1` }),
      );
      if (listing.truncated)
        throw new VaultAccessError('the vault holds more files than GitHub lists in one answer');
      return listing;
    },
    blob: (sha) => blobOf(api, `${repo}/git/blobs/${sha}`, sha),
    upload: (bytes) => upload(api, `${repo}/git/blobs`, bytes),
    commit: (asked) => commit(api, { repo, ref }, asked),
  };
}

async function headOf(api: GitHubApi, path: string): Promise<string> {
  try {
    return readRefSha(await api.send({ method: 'GET', path }));
  } catch (error) {
    if (error instanceof GitHubRefusedError && (error.status === 404 || error.status === 409))
      throw new VaultAccessError("the vault's branch is not on GitHub");
    throw error;
  }
}

/** A blob's bytes, refused unless they are the blob asked for: what is read is what is there. */
async function blobOf(api: GitHubApi, path: string, sha: string): Promise<Uint8Array> {
  const bytes = base64ToBytes(readBlobBase64(await api.send({ method: 'GET', path })));
  if (bytes === null || (await gitBlobSha(bytes)) !== sha)
    throw new VaultAccessError(GITHUB_MALFORMED);
  return bytes;
}

async function upload(api: GitHubApi, path: string, bytes: Uint8Array): Promise<string> {
  const expected = await gitBlobSha(bytes);
  const body = { content: bytesToBase64(bytes), encoding: 'base64' };
  const sha = readCreatedSha(await api.send({ method: 'POST', path, body }));
  // A blob GitHub names otherwise holds other bytes: commit nothing on it.
  if (sha !== expected) throw new VaultAccessError('GitHub stored other bytes than DFAI sent');
  return sha;
}

async function commit(
  api: GitHubApi,
  { repo, ref }: { repo: string; ref: string },
  asked: CommitAsked,
): Promise<string> {
  const tree = readCreatedSha(
    await api.send({
      method: 'POST',
      path: `${repo}/git/trees`,
      body: { base_tree: asked.tree, tree: asked.changes },
    }),
  );
  const made = readCreatedSha(
    await api.send({
      method: 'POST',
      path: `${repo}/git/commits`,
      body: { message: asked.message, tree, parents: [asked.head] },
    }),
  );
  try {
    await api.send({
      method: 'PATCH',
      path: `${repo}/git/refs/${ref}`,
      body: { sha: made, force: false },
    });
  } catch (error) {
    // Not a fast-forward (422), or the ref changed under the update (409): another
    // device's commit is there. Never forced; the write is refused as stale.
    if (error instanceof GitHubRefusedError && (error.status === 422 || error.status === 409))
      throw asked.moved();
    throw error;
  }
  return made;
}
