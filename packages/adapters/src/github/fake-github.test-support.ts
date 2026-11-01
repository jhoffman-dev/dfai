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
 * Trees and commits are named by a hash of their contents rather than git's
 * exact encoding: the vault treats those names as opaque, and only blob
 * names are ever computed on its side.
 */

type Entries = ReadonlyMap<string, { readonly mode: string; readonly sha: string }>;
interface Commit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
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
  readonly files: Readonly<Record<string, string | Uint8Array>>;
  readonly where?: GitHubVaultRepository;
  /** The repositories the App's one installation reaches; the vault's alone by default. */
  readonly reached?: readonly GitHubVaultRepository[];
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

export class FakeGitHub {
  readonly where: GitHubVaultRepository;
  readonly received: Received[] = [];
  readonly tokens = new Set([FAKE_TOKEN]);
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly trees = new Map<string, Entries>();
  private readonly commits = new Map<string, Commit>();
  private readonly interceptions: Interception[] = [];
  private readonly reached: readonly GitHubVaultRepository[];
  private head = '';
  private made = 0;
  private readonly ready: Promise<void>;

  constructor({ files, where = FAKE_VAULT, reached = [where] }: FakeGitHubOptions) {
    this.where = where;
    this.reached = reached;
    this.ready = this.seed(files);
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
    const entries = new Map(this.entriesAt(this.head));
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) entries.delete(path);
      else entries.set(path, { mode: '100644', sha: await this.store(content) });
    }
    this.head = await this.commit(await this.putTree(entries), [this.head], 'Outside');
    return this.head;
  }

  /** The bytes at `path` on the branch now, or undefined. */
  async bytesAt(path: string): Promise<Uint8Array | undefined> {
    await this.ready;
    const entry = this.entriesAt(this.head).get(path);
    return entry === undefined ? undefined : this.blobs.get(entry.sha);
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
    return [...this.entriesAt(this.head).keys()].sort();
  }

  /** The messages of the branch's commits, newest first. */
  async history(): Promise<string[]> {
    await this.ready;
    const messages: string[] = [];
    for (
      let at: string | undefined = this.head;
      at !== undefined;
      at = this.commits.get(at)?.parents[0]
    )
      messages.push(this.commits.get(at)!.message);
    return messages;
  }

  async headSha(): Promise<string> {
    await this.ready;
    return this.head;
  }

  /** Requests sent, as `METHOD path` without the repository prefix. */
  sentCalls(): string[] {
    const prefix = `/repos/${this.where.owner}/${this.where.repo}`;
    return this.received.map(({ method, path }) => `${method} ${path.replace(prefix, '')}`);
  }

  private async seed(files: FakeGitHubOptions['files']) {
    const entries = new Map<string, { mode: string; sha: string }>();
    for (const [path, content] of Object.entries(files))
      entries.set(path, { mode: '100644', sha: await this.store(content) });
    this.head = await this.commit(await this.putTree(entries), [], 'Seed');
  }

  private async store(content: string | Uint8Array): Promise<string> {
    const bytes = typeof content === 'string' ? utf8(content) : content;
    const sha = await gitBlobSha(bytes);
    this.blobs.set(sha, bytes.slice());
    return sha;
  }

  private async putTree(entries: Entries): Promise<string> {
    const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : 1));
    const sha = await shaOfText(`tree ${JSON.stringify(sorted)}`);
    this.trees.set(sha, new Map(sorted));
    return sha;
  }

  private async commit(tree: string, parents: readonly string[], message: string): Promise<string> {
    const sha = await shaOfText(
      `commit ${++this.made} ${JSON.stringify({ tree, parents, message })}`,
    );
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }

  private entriesAt(commitOrTree: string): Entries {
    return this.trees.get(this.commits.get(commitOrTree)?.tree ?? commitOrTree) ?? new Map();
  }

  private route(request: Received): Answer {
    const repo = `/repos/${this.where.owner}/${this.where.repo}/git`;
    const branchRef = `heads/${this.where.branch}`;
    const { method, path } = request;
    if (method === 'GET' && path === `${repo}/ref/${branchRef}`)
      return json(200, { ref: `refs/${branchRef}`, object: { type: 'commit', sha: this.head } });
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

  private routeUser({ method, path }: Received): Answer {
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

  private listTree(sha: string): Response {
    const treeSha = this.commits.get(sha)?.tree ?? sha;
    const entries = this.trees.get(treeSha);
    if (entries === undefined) return refusal(404, 'Not Found');
    const folders = new Set<string>();
    for (const path of entries.keys()) {
      const segments = path.split('/').slice(0, -1);
      segments.forEach((_, end) => folders.add(segments.slice(0, end + 1).join('/')));
    }
    const listed = [
      ...[...folders].map((path) => ({ path, mode: '040000', type: 'tree', sha: treeSha })),
      ...[...entries].map(([path, { mode, sha: blob }]) => ({
        path,
        mode,
        type: 'blob',
        sha: blob,
        size: this.blobs.get(blob)!.byteLength,
      })),
    ].sort((a, b) => (a.path < b.path ? -1 : 1));
    return json(200, { sha: treeSha, tree: listed, truncated: false });
  }

  private readBlob(sha: string): Response {
    const bytes = this.blobs.get(sha);
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
    if (base === undefined || !this.trees.has(base) || !Array.isArray(tree))
      return refusal(422, 'Invalid tree info');
    const entries = new Map(this.trees.get(base)!);
    for (const raw of tree as { path: string; mode: string; type: string; sha: string | null }[]) {
      if (raw.type !== 'blob') return refusal(422, 'Invalid tree info');
      if (raw.sha === null) {
        if (!entries.delete(raw.path)) return refusal(422, `${raw.path} is not in the tree`);
      } else if (!this.blobs.has(raw.sha)) return refusal(422, 'Invalid tree info');
      else entries.set(raw.path, { mode: raw.mode, sha: raw.sha });
    }
    const paths = [...entries.keys()];
    if (paths.some((path) => paths.some((other) => other.startsWith(`${path}/`))))
      return refusal(422, 'A path is both a file and a folder');
    return json(201, { sha: await this.putTree(entries) });
  }

  private async createCommit(body: unknown): Promise<Response> {
    const { message, tree, parents } = body as {
      message?: string;
      tree?: string;
      parents?: string[];
    };
    if (typeof message !== 'string' || tree === undefined || !this.trees.has(tree))
      return refusal(422, 'Invalid commit');
    if (!Array.isArray(parents) || parents.some((parent) => !this.commits.has(parent)))
      return refusal(422, 'Invalid parent');
    return json(201, { sha: await this.commit(tree, parents, message) });
  }

  private updateRef(body: unknown): Response {
    const { sha, force } = body as { sha?: string; force?: boolean };
    if (sha === undefined || !this.commits.has(sha)) return refusal(422, 'Object does not exist');
    if (force !== true && !this.descends(sha, this.head))
      return refusal(422, 'Update is not a fast forward');
    this.head = sha;
    return json(200, { ref: `refs/heads/${this.where.branch}`, object: { type: 'commit', sha } });
  }

  private descends(commit: string, ancestor: string): boolean {
    if (commit === ancestor) return true;
    return (this.commits.get(commit)?.parents ?? []).some((parent) =>
      this.descends(parent, ancestor),
    );
  }
}
