import { VaultAccessError } from '@dfai/application';
import { WEB_COMMIT_AUTHOR } from '@dfai/domain';
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
  /**
   * A save's one file, its blob and mode as they were at `head`. Given, a branch that moved meanwhile
   * with this file still that blob is not a refusal: the change is made again,
   * once, on the new head — another device's push to another note is no
   * conflict. Only a save gives it: a create, a move or a trash was decided
   * against the whole tree, which the other push may have changed.
   */
  readonly unchanged?: { readonly path: string; readonly sha: string; readonly mode: string };
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
      const listing = await treeAt(api, repo, commit);
      if (listing.truncated)
        throw new VaultAccessError('the vault holds more files than GitHub lists in one answer');
      return listing;
    },
    blob: (sha) => blobOf(api, `${repo}/git/blobs/${sha}`, sha),
    upload: (bytes) => upload(api, `${repo}/git/blobs`, bytes),
    commit: (asked) => commitOnMovedHead(api, { repo, ref }, asked),
  };
}

const treeAt = async (api: GitHubApi, repo: string, commit: string) =>
  readTree(await api.send({ method: 'GET', path: `${repo}/git/trees/${commit}?recursive=1` }));

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

interface Ref {
  readonly repo: string;
  readonly ref: string;
}

/** A commit, made again once on a moved head where the save's file is as it was. */
async function commitOnMovedHead(api: GitHubApi, where: Ref, asked: CommitAsked): Promise<string> {
  const made = await commit(api, where, asked);
  if (made !== null) return made;
  const again = asked.unchanged === undefined ? null : await movedPast(api, where, asked);
  const retried = again === null ? null : await commit(api, where, { ...asked, ...again });
  if (retried === null) throw asked.moved();
  return retried;
}

/** The head the branch moved to, and its tree, when the save's file is there unchanged. */
async function movedPast(
  api: GitHubApi,
  { repo, ref }: Ref,
  asked: CommitAsked,
): Promise<{ head: string; tree: string } | null> {
  const head = await headOf(api, `${repo}/git/ref/${ref}`);
  // Not moved: GitHub refused the update for its own reason, and trying again
  // would only be refused again.
  if (head === asked.head) return null;
  const listing = await treeAt(api, repo, head);
  if (listing.truncated) return null;
  const file = listing.entries.find((entry) => entry.path === asked.unchanged?.path);
  // The same bytes under another mode — made executable, or a link to the
  // same text — is a change too, which the save would write over.
  const same =
    file?.type === 'blob' &&
    file.sha === asked.unchanged?.sha &&
    file.mode === asked.unchanged.mode;
  return same ? { head, tree: listing.sha } : null;
}

/** Commits the changes on `head` and moves the branch to it; null when it moved meanwhile. */
async function commit(
  api: GitHubApi,
  { repo, ref }: Ref,
  asked: CommitAsked,
): Promise<string | null> {
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
      // Authored by the web, not the signed-in person alone, so the history says where it came from.
      body: { message: asked.message, tree, parents: [asked.head], author: WEB_COMMIT_AUTHOR },
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
      return null;
    throw error;
  }
  return made;
}
