import {
  RemoteAuthError,
  RemoteMovedError,
  type Clock,
  type PushCommit,
  type RemoteEntry,
  type RemoteHead,
  type RemoteVault,
} from '../../application/index.ts';
import { systemClock } from '../clock/index.ts';
import { base64ToBytes, bytesToBase64, gitBlobSha, textOfBytes, utf8 } from './git-bytes.ts';
import {
  GITHUB_MALFORMED,
  readBlobBase64,
  readCommitTreeSha,
  readContentsCommit,
  readCreatedSha,
  readRefSha,
  readTree,
} from './github-answers.ts';
import { GitHubRefusedError, gitHubApi, type GitHubApi } from './github-api.ts';

export interface GitHubRemoteOptions {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  /** A fine-grained personal access token with Contents read and write on the repository. */
  readonly token: string;
  readonly fetch: typeof globalThis.fetch;
  /** The rest have browser defaults; tests replace them so no real time passes. */
  readonly clock?: Clock;
  readonly wait?: (ms: number) => Promise<void>;
  readonly timeout?: (ms: number) => Promise<void>;
}

/** How many blobs are read, or written, at once. */
const BLOB_CONCURRENCY = 8;
/** A regular, non-executable file. */
const FILE_MODE = '100644';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The vault's branch through GitHub's Git Data API: the ref, the commit's
 * recursive tree, blobs read in parallel; a push makes blobs, a tree on
 * `base_tree`, a commit, and moves the ref as a fast-forward only
 * (`force: false`). An empty repository has no head, and its first push
 * creates the branch.
 */
export function createGitHubRemote(options: GitHubRemoteOptions): RemoteVault {
  const api = gitHubApi({
    fetch: options.fetch,
    token: options.token,
    clock: options.clock ?? systemClock,
    wait: options.wait ?? sleep,
    timeout: options.timeout ?? sleep,
  });
  const repo = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
  const at: Where = { api, repo, branch: options.branch };
  return {
    head: () => headOf(at),
    tree: (treeSha) => treeOf(at, treeSha),
    blobs: (shas) => blobsOf(at, shas),
    push: (commit) => push(at, commit),
  };
}

interface Where {
  readonly api: GitHubApi;
  /** `/repos/<owner>/<repo>`, encoded. */
  readonly repo: string;
  readonly branch: string;
}

/** The ref path segment by segment, so a branch like `notes/main` stays one ref. */
const refOf = (branch: string) => `heads/${branch.split('/').map(encodeURIComponent).join('/')}`;

const isRefused = (error: unknown, ...statuses: number[]): error is GitHubRefusedError =>
  error instanceof GitHubRefusedError && statuses.includes(error.status);

async function headOf(at: Where): Promise<RemoteHead | null> {
  let commitSha: string;
  try {
    commitSha = readRefSha(
      await at.api.send({ method: 'GET', path: `${at.repo}/git/ref/${refOf(at.branch)}` }),
    );
  } catch (error) {
    // 409: the repository has no commit at all. 404: no such branch, or no such repository.
    if (isRefused(error, 409)) return null;
    if (isRefused(error, 404)) return missingBranch(at);
    throw error;
  }
  const commit = await at.api.send({ method: 'GET', path: `${at.repo}/git/commits/${commitSha}` });
  return { commitSha, treeSha: readCommitTreeSha(commit) };
}

/** A 404 for the branch: null when the repository is there, else the token cannot see it. */
async function missingBranch(at: Where): Promise<null> {
  try {
    await at.api.send({ method: 'GET', path: at.repo });
  } catch (error) {
    // GitHub answers 404, not 403, for a private repository the token may not read.
    if (isRefused(error, 404))
      throw new RemoteAuthError('GitHub has no such repository that this token can reach.');
    throw error;
  }
  return null;
}

async function treeOf(at: Where, treeSha: string): Promise<RemoteEntry[]> {
  const listing = readTree(
    await at.api.send({ method: 'GET', path: `${at.repo}/git/trees/${treeSha}?recursive=1` }),
  );
  // A partial list would read as remote deletes: refuse it rather than sync against it.
  if (listing.truncated)
    throw new Error('The vault holds more files than GitHub lists in one answer.');
  return listing.entries
    .filter(({ type, mode }) => type === 'blob' && mode !== '120000')
    .map(({ path, sha }) => ({ path, sha }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

async function blobsOf(at: Where, shas: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(shas)];
  const texts = await inParallel(unique, async (sha) => textOfBytes(await blobOf(at, sha)));
  return new Map(unique.map((sha, index) => [sha, texts[index] as string]));
}

/** A blob's bytes, refused unless they are the blob asked for: what is read is what is there. */
async function blobOf(at: Where, sha: string): Promise<Uint8Array> {
  const answer = await at.api.send({ method: 'GET', path: `${at.repo}/git/blobs/${sha}` });
  const bytes = base64ToBytes(readBlobBase64(answer));
  if (bytes === null || (await gitBlobSha(bytes)) !== sha) throw new Error(GITHUB_MALFORMED);
  return bytes;
}

/** `work` over every item, at most {@link BLOB_CONCURRENCY} at once, results in order. */
async function inParallel<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++)
      results[index] = await work(items[index] as T);
  };
  await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, items.length) }, worker));
  return results;
}

async function push(at: Where, commit: PushCommit): Promise<RemoteHead> {
  if (commit.parentCommitSha !== null) {
    const parent = await at.api.send({
      method: 'GET',
      path: `${at.repo}/git/commits/${commit.parentCommitSha}`,
    });
    return commitOn(at, {
      ...commit,
      parent: commit.parentCommitSha,
      baseTree: readCommitTreeSha(parent),
    });
  }
  try {
    return await commitOn(at, { ...commit, parent: null, baseTree: null });
  } catch (error) {
    // 409 "Git Repository is empty": the Git Data API needs one commit to exist first.
    if (isRefused(error, 409)) return pushIntoEmptyRepository(at, commit);
    throw error;
  }
}

interface Commitment extends PushCommit {
  readonly parent: string | null;
  readonly baseTree: string | null;
}

async function commitOn(at: Where, asked: Commitment): Promise<RemoteHead> {
  const blobs = await inParallel(asked.upserts, ({ text }) => uploadBlob(at, text));
  const tree = [
    ...asked.upserts.map(({ path }, index) => ({
      path,
      mode: FILE_MODE,
      type: 'blob',
      sha: blobs[index],
    })),
    // Nothing to take away from a tree that does not exist yet.
    ...(asked.baseTree === null ? [] : asked.deletes).map((path) => ({
      path,
      mode: FILE_MODE,
      type: 'blob',
      sha: null,
    })),
  ];
  const treeSha = readCreatedSha(
    await at.api.send({
      method: 'POST',
      path: `${at.repo}/git/trees`,
      body: asked.baseTree === null ? { tree } : { base_tree: asked.baseTree, tree },
    }),
  );
  const commitSha = readCreatedSha(
    await at.api.send({
      method: 'POST',
      path: `${at.repo}/git/commits`,
      body: {
        message: asked.message,
        tree: treeSha,
        parents: asked.parent === null ? [] : [asked.parent],
      },
    }),
  );
  await moveBranch(at, { parent: asked.parent, commitSha });
  return { commitSha, treeSha };
}

/** Stores the text as a blob, checked to be git's name for exactly its bytes. */
async function uploadBlob(at: Where, text: string): Promise<string> {
  const bytes = utf8(text);
  const body = { content: bytesToBase64(bytes), encoding: 'base64' };
  const sha = readCreatedSha(
    await at.api.send({ method: 'POST', path: `${at.repo}/git/blobs`, body }),
  );
  // A blob GitHub names otherwise holds other bytes: commit nothing on it.
  if (sha !== (await gitBlobSha(bytes)))
    throw new Error('GitHub stored other bytes than were sent.');
  return sha;
}

/** Fast-forwards the branch to `commitSha`, or creates it; another device's commit there is a move. */
async function moveBranch(
  at: Where,
  { parent, commitSha }: { parent: string | null; commitSha: string },
): Promise<void> {
  try {
    await (parent === null
      ? at.api.send({
          method: 'POST',
          path: `${at.repo}/git/refs`,
          body: { ref: `refs/${refOf(at.branch)}`, sha: commitSha },
        })
      : at.api.send({
          method: 'PATCH',
          path: `${at.repo}/git/refs/${refOf(at.branch)}`,
          body: { sha: commitSha, force: false },
        }));
  } catch (error) {
    // 422: not a fast-forward, or the branch already exists; 409: the ref changed under the update.
    if (isRefused(error, 422, 409)) throw new RemoteMovedError();
    throw error;
  }
}

/**
 * The first push into a repository with no commit: the Contents API writes
 * the first file (creating the branch), then the rest go on top of it.
 */
async function pushIntoEmptyRepository(at: Where, commit: PushCommit): Promise<RemoteHead> {
  const [first, ...rest] = commit.upserts;
  if (first === undefined) throw new Error('An empty repository needs a file to start it.');
  const path = first.path.split('/').map(encodeURIComponent).join('/');
  let head: RemoteHead;
  try {
    head = readContentsCommit(
      await at.api.send({
        method: 'PUT',
        path: `${at.repo}/contents/${path}`,
        body: {
          message: commit.message,
          content: bytesToBase64(utf8(first.text)),
          branch: at.branch,
        },
      }),
    );
  } catch (error) {
    // Someone else made the first commit meanwhile.
    if (isRefused(error, 409, 422)) throw new RemoteMovedError();
    throw error;
  }
  if (rest.length === 0) return head;
  return commitOn(at, {
    ...commit,
    upserts: rest,
    deletes: [],
    parent: head.commitSha,
    baseTree: head.treeSha,
  });
}
