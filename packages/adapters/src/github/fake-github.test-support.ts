import { bytesToBase64, base64ToBytes, gitBlobSha, utf8 } from './git-bytes.ts';
import type { GitHubVaultRepository } from './git-branch.ts';

/**
 * A faithful local stand-in for the parts of GitHub's REST API the GitHub
 * vault uses (#664): the Git Data endpoints (ref, recursive tree, blobs,
 * trees, commits, a ref update) and the installation listing, held in
 * memory and answered through an injected `fetch`, so no test reaches the
 * network. It keeps GitHub's rules that matter to a write:
 *
 * - blobs are named as git names them (`sha1("blob <n>\0" + bytes)`), and
 *   read back as base64 broken every 60 characters, as GitHub sends them;
 * - a tree is built on a `base_tree`, a `sha: null` entry takes a path away,
 *   and an entry naming a blob or a base that is not there is a 422;
 * - a ref update without `force` must be a fast-forward, or it is a 422
 *   `Update is not a fast forward`;
 * - a token not issued is a 401 `Bad credentials`.
 *
 * Its objects and its branch are held by a {@link GitObjects}: in memory by
 * default, where trees and commits are named by a hash of their contents
 * rather than git's exact encoding (the vault treats those names as opaque,
 * and only blob names are ever computed on its side); or a real repository,
 * so the web writes the very branch the desktops sync with (#665).
 */

/** A tree's files, flattened, by path. */
export type Entries = ReadonlyMap<string, { readonly mode: string; readonly sha: string }>;

/** Who a commit is by, as the API takes it. */
export interface CommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface Commit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  /** Absent when the request named none; GitHub then records the signed-in person. */
  readonly author?: CommitAuthor;
}

/** Where the stand-in keeps its blobs, trees, commits and the branch's head. */
export interface GitObjects {
  head(): Promise<string>;
  /** Moves the head from `from` to `to`, only if it is still at `from`. */
  moveHead(args: { from: string; to: string }): Promise<boolean>;
  putBlob(bytes: Uint8Array): Promise<string>;
  blob(sha: string): Promise<Uint8Array | undefined>;
  putTree(entries: Entries): Promise<string>;
  /** A tree's files, or undefined when `sha` names no tree. */
  tree(sha: string): Promise<Entries | undefined>;
  putCommit(commit: Commit): Promise<string>;
  commit(sha: string): Promise<Commit | undefined>;
}

/** A request as the stand-in received it. */
export interface Received {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly headers: Headers;
  readonly cache: RequestCache | undefined;
}

type Answer = Response | Promise<Response>;
interface Interception {
  readonly match: (request: Received) => boolean;
  readonly answer: (request: Received, signal: AbortSignal | undefined) => Answer;
}

export interface FakeGitHubOptions {
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  readonly where?: GitHubVaultRepository;
  /** Symbolic links, by path, to the target each names: blobs of mode 120000. */
  readonly links?: Readonly<Record<string, string>>;
  /** The repositories the App's one installation reaches; the vault's alone by default. */
  readonly reached?: readonly GitHubVaultRepository[];
  /** A store already holding the branch, in place of one seeded with `files` in memory. */
  readonly objects?: GitObjects;
}

export const FAKE_TOKEN = 'ghu_fake-token-one';
export const FAKE_VAULT: GitHubVaultRepository = {
  owner: 'mara-quill',
  repo: 'larkspur-vault',
  branch: 'main',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (status: number, message: string) => json(status, { message });

async function shaOfText(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', utf8(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The stand-in's own store, in memory. */
export function memoryGitObjects(): GitObjects {
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, Entries>();
  const commits = new Map<string, Commit>();
  let head = '';
  let made = 0;
  return {
    head: async () => head,
    moveHead: async ({ from, to }) => {
      if (head !== from) return false;
      head = to;
      return true;
    },
    putBlob: async (bytes) => {
      const sha = await gitBlobSha(bytes);
      blobs.set(sha, bytes.slice());
      return sha;
    },
    blob: async (sha) => blobs.get(sha),
    putTree: async (entries) => {
      const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : 1));
      const sha = await shaOfText(`tree ${JSON.stringify(sorted)}`);
      trees.set(sha, new Map(sorted));
      return sha;
    },
    tree: async (sha) => trees.get(sha),
    putCommit: async (commit) => {
      const sha = await shaOfText(`commit ${++made} ${JSON.stringify(commit)}`);
      commits.set(sha, commit);
      return sha;
    },
    commit: async (sha) => commits.get(sha),
  };
}

export class FakeGitHub {
  readonly where: GitHubVaultRepository;
  readonly received: Received[] = [];
  readonly tokens = new Set([FAKE_TOKEN]);
  /** Who each token signs in as, for `GET /user`; the vault's owner when not named. */
  readonly logins = new Map<string, string>();
  readonly objects: GitObjects;
  private readonly interceptions: Interception[] = [];
  private readonly reached: readonly GitHubVaultRepository[];
  private readonly ready: Promise<void>;

  constructor({
    files,
    links = {},
    where = FAKE_VAULT,
    reached = [where],
    objects,
  }: FakeGitHubOptions) {
    this.where = where;
    this.reached = reached;
    this.objects = objects ?? memoryGitObjects();
    this.ready = objects === undefined ? this.seed(files, links) : Promise.resolve();
  }

  /** `fetch`, as the vault is given it. */
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    await this.ready;
    const url = new URL(String(input));
    const request: Received = {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      headers: new Headers(init?.headers),
      cache: init?.cache,
    };
    this.received.push(request);
    const index = this.interceptions.findIndex(({ match }) => match(request));
    if (index >= 0)
      return this.interceptions.splice(index, 1)[0]!.answer(request, init?.signal ?? undefined);
    return this.respond(request);
  };

  /** What GitHub answers `request` with, past any interception: for one that acts, then lets it through. */
  respond(request: Received): Answer {
    if (!this.tokens.has(request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''))
      return refusal(401, 'Bad credentials');
    return this.route(request);
  }

  /** The next request `match` takes is answered by `answer` instead, once. */
  intercept(match: (request: Received) => boolean, answer: Interception['answer']): void {
    this.interceptions.push({ match, answer });
  }

  /** The next request `match` takes never answers, until it is aborted. */
  hang(match: (request: Received) => boolean): void {
    this.intercept(
      match,
      (_request, signal) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('aborted', 'AbortError'));
          // As fetch does, a signal aborted before the answer began is refused at once.
          if (signal?.aborted) abort();
          signal?.addEventListener('abort', abort);
        }),
    );
  }

  /** Another device commits on the branch: `null` takes a path away. */
  async commitOutside(
    changes: Readonly<Record<string, string | Uint8Array | null>>,
  ): Promise<string> {
    await this.ready;
    const from = await this.objects.head();
    const entries = new Map(await this.entriesAt(from));
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) entries.delete(path);
      else entries.set(path, { mode: '100644', sha: await this.store(content) });
    }
    const tree = await this.objects.putTree(entries);
    const to = await this.objects.putCommit({ tree, parents: [from], message: 'Outside' });
    await this.objects.moveHead({ from, to });
    return to;
  }

  /** The bytes at `path` on the branch now, or undefined. */
  async bytesAt(path: string): Promise<Uint8Array | undefined> {
    await this.ready;
    const entry = (await this.entriesAt(await this.objects.head())).get(path);
    return entry === undefined ? undefined : this.objects.blob(entry.sha);
  }

  async textAt(path: string): Promise<string | undefined> {
    const bytes = await this.bytesAt(path);
    return bytes === undefined
      ? undefined
      : new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  }

  /** Every path on the branch now, sorted. */
  async paths(): Promise<string[]> {
    await this.ready;
    return [...(await this.entriesAt(await this.objects.head())).keys()].sort();
  }

  /** The branch's commits along first parents, newest first. */
  async commits(): Promise<Commit[]> {
    await this.ready;
    const found: Commit[] = [];
    for (let at: string | undefined = await this.objects.head(); at !== undefined;) {
      const commit = await this.objects.commit(at);
      if (commit === undefined) break;
      found.push(commit);
      at = commit.parents[0];
    }
    return found;
  }

  /** The messages of the branch's commits, newest first. */
  async history(): Promise<string[]> {
    return (await this.commits()).map(({ message }) => message);
  }

  async headSha(): Promise<string> {
    await this.ready;
    return this.objects.head();
  }

  /** Requests sent, as `METHOD path` without the repository prefix. */
  sentCalls(): string[] {
    const prefix = `/repos/${this.where.owner}/${this.where.repo}`;
    return this.received.map(({ method, path }) => `${method} ${path.replace(prefix, '')}`);
  }

  private async seed(
    files: FakeGitHubOptions['files'] = {},
    links: Readonly<Record<string, string>>,
  ) {
    const entries = new Map<string, { mode: string; sha: string }>();
    for (const [path, content] of Object.entries(files))
      entries.set(path, { mode: '100644', sha: await this.store(content) });
    for (const [path, target] of Object.entries(links))
      entries.set(path, { mode: '120000', sha: await this.store(target) });
    const tree = await this.objects.putTree(entries);
    const to = await this.objects.putCommit({ tree, parents: [], message: 'Seed' });
    await this.objects.moveHead({ from: '', to });
  }

  private store(content: string | Uint8Array): Promise<string> {
    return this.objects.putBlob(typeof content === 'string' ? utf8(content) : content);
  }

  /** A tree's files, named by the tree or by a commit of it; none for a name of neither. */
  private async entriesAt(commitOrTree: string): Promise<Entries> {
    const tree = (await this.objects.commit(commitOrTree))?.tree ?? commitOrTree;
    return (await this.objects.tree(tree)) ?? new Map();
  }

  private route(request: Received): Answer {
    const repo = `/repos/${this.where.owner}/${this.where.repo}/git`;
    const branchRef = `heads/${this.where.branch}`;
    const { method, path } = request;
    if (method === 'GET' && path === `${repo}/ref/${branchRef}`) return this.readRef(branchRef);
    const tree = new RegExp(`^${repo}/trees/([0-9a-f]+)\\?recursive=1$`).exec(path);
    if (method === 'GET' && tree) return this.listTree(tree[1]!);
    const blob = new RegExp(`^${repo}/blobs/([0-9a-f]+)$`).exec(path);
    if (method === 'GET' && blob) return this.readBlob(blob[1]!);
    if (method === 'POST' && path === `${repo}/blobs`) return this.createBlob(request.body);
    if (method === 'POST' && path === `${repo}/trees`) return this.createTree(request.body);
    if (method === 'POST' && path === `${repo}/commits`) return this.createCommit(request.body);
    if (method === 'PATCH' && path === `${repo}/refs/${branchRef}`)
      return this.updateRef(request.body);
    return this.routeUser(request);
  }

  private routeUser({ method, path, headers }: Received): Answer {
    if (method === 'GET' && path === '/user') {
      const token = headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
      return json(200, { login: this.logins.get(token) ?? this.where.owner });
    }
    if (method === 'GET' && path === '/user/installations')
      return json(200, { total_count: 1, installations: [{ id: 7 }] });
    if (method === 'GET' && /^\/user\/installations\/7\/repositories(\?|$)/.test(path))
      return json(200, {
        total_count: this.reached.length,
        repositories: this.reached.map(({ owner, repo, branch }) => ({
          name: repo,
          owner: { login: owner },
          default_branch: branch,
        })),
      });
    return refusal(404, 'Not Found');
  }

  private async readRef(branchRef: string): Promise<Response> {
    const sha = await this.objects.head();
    return json(200, { ref: `refs/${branchRef}`, object: { type: 'commit', sha } });
  }

  private async listTree(sha: string): Promise<Response> {
    const treeSha = (await this.objects.commit(sha))?.tree ?? sha;
    const entries = await this.objects.tree(treeSha);
    if (entries === undefined) return refusal(404, 'Not Found');
    const folders = new Set<string>();
    for (const path of entries.keys()) {
      const segments = path.split('/').slice(0, -1);
      segments.forEach((_, end) => folders.add(segments.slice(0, end + 1).join('/')));
    }
    const files = await Promise.all(
      [...entries].map(async ([path, { mode, sha: blob }]) => ({
        path,
        mode,
        type: 'blob',
        sha: blob,
        size: (await this.objects.blob(blob))!.byteLength,
      })),
    );
    const listed = [
      ...[...folders].map((path) => ({ path, mode: '040000', type: 'tree', sha: treeSha })),
      ...files,
    ].sort((a, b) => (a.path < b.path ? -1 : 1));
    return json(200, { sha: treeSha, tree: listed, truncated: false });
  }

  private async readBlob(sha: string): Promise<Response> {
    const bytes = await this.objects.blob(sha);
    if (bytes === undefined) return refusal(404, 'Not Found');
    const content = (bytesToBase64(bytes).match(/.{1,60}/g) ?? []).join('\n');
    return json(200, { sha, size: bytes.byteLength, content: `${content}\n`, encoding: 'base64' });
  }

  private async createBlob(body: unknown): Promise<Response> {
    const { content, encoding } = body as { content?: unknown; encoding?: unknown };
    if (typeof content !== 'string' || encoding !== 'base64')
      return refusal(422, 'Invalid request');
    const bytes = base64ToBytes(content);
    if (bytes === null) return refusal(422, 'Invalid base64');
    return json(201, { sha: await this.store(bytes) });
  }

  private async createTree(body: unknown): Promise<Response> {
    const { base_tree: base, tree } = body as { base_tree?: string; tree?: unknown };
    const based = base === undefined ? undefined : await this.objects.tree(base);
    if (based === undefined || !Array.isArray(tree)) return refusal(422, 'Invalid tree info');
    const entries = new Map(based);
    for (const raw of tree as { path: string; mode: string; type: string; sha: string | null }[]) {
      if (raw.type !== 'blob') return refusal(422, 'Invalid tree info');
      if (raw.sha === null) {
        if (!entries.delete(raw.path)) return refusal(422, `${raw.path} is not in the tree`);
      } else if ((await this.objects.blob(raw.sha)) === undefined)
        return refusal(422, 'Invalid tree info');
      else entries.set(raw.path, { mode: raw.mode, sha: raw.sha });
    }
    const paths = [...entries.keys()];
    if (paths.some((path) => paths.some((other) => other.startsWith(`${path}/`))))
      return refusal(422, 'A path is both a file and a folder');
    return json(201, { sha: await this.objects.putTree(entries) });
  }

  private async createCommit(body: unknown): Promise<Response> {
    const { message, tree, parents, author } = body as {
      message?: string;
      tree?: string;
      parents?: string[];
      author?: CommitAuthor;
    };
    if (typeof message !== 'string' || tree === undefined) return refusal(422, 'Invalid commit');
    if ((await this.objects.tree(tree)) === undefined) return refusal(422, 'Invalid commit');
    if (
      author !== undefined &&
      (typeof author.name !== 'string' || typeof author.email !== 'string')
    )
      return refusal(422, 'Invalid author');
    if (!Array.isArray(parents)) return refusal(422, 'Invalid parent');
    for (const parent of parents)
      if ((await this.objects.commit(parent)) === undefined) return refusal(422, 'Invalid parent');
    const commit: Commit = { tree, parents, message, ...(author !== undefined && { author }) };
    return json(201, { sha: await this.objects.putCommit(commit) });
  }

  private async updateRef(body: unknown): Promise<Response> {
    const { sha, force } = body as { sha?: string; force?: boolean };
    if (sha === undefined || (await this.objects.commit(sha)) === undefined)
      return refusal(422, 'Object does not exist');
    const head = await this.objects.head();
    if (force !== true && !(await this.descends(sha, head)))
      return refusal(422, 'Update is not a fast forward');
    // The head is moved only from where it was checked, as GitHub's ref update is atomic.
    if (!(await this.objects.moveHead({ from: head, to: sha })))
      return refusal(422, 'Update is not a fast forward');
    return json(200, { ref: `refs/heads/${this.where.branch}`, object: { type: 'commit', sha } });
  }

  private async descends(commit: string, ancestor: string): Promise<boolean> {
    if (commit === ancestor) return true;
    for (const parent of (await this.objects.commit(commit))?.parents ?? [])
      if (await this.descends(parent, ancestor)) return true;
    return false;
  }
}
