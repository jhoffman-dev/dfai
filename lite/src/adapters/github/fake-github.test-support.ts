import { base64ToBytes, bytesToBase64, gitBlobSha, utf8 } from './git-bytes.ts';

/**
 * A faithful in-process stand-in for the parts of GitHub's REST API the
 * remote uses, answered through an injected `fetch` so no test reaches the
 * network. Adapted from DFAI's. It keeps GitHub's rules that matter to a push:
 *
 * - blobs are named as git names them, and read back as base64 broken every
 *   60 characters;
 * - a repository with no commit answers 409 to the ref and to blob writes,
 *   and is started by a Contents API write;
 * - a tree is built on an optional `base_tree`; a `sha: null` entry takes a
 *   path away;
 * - a ref update without `force` must be a fast-forward, or it is a 422;
 * - a token not issued is a 401 `Bad credentials`.
 *
 * Trees and commits are named by a hash of their contents, not git's exact
 * encoding: the remote treats those names as opaque.
 */

type Entries = Map<string, { mode: string; sha: string }>;
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
}

type Answer = (request: Received, signal: AbortSignal | undefined) => Response | Promise<Response>;

export const FAKE_TOKEN = 'github_pat_fake-token-one';
export const FAKE_REPO = { owner: 'mara-quill', repo: 'larkspur-notes', branch: 'main' } as const;
const REPO = `/repos/${FAKE_REPO.owner}/${FAKE_REPO.repo}`;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (status: number, message: string) => json(status, { message });

async function shaOfText(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', utf8(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class FakeGitHub {
  readonly received: Received[] = [];
  /** Answer the next recursive tree listing as truncated. */
  truncateTrees = false;
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly trees = new Map<string, Entries>();
  private readonly commitsBySha = new Map<string, Commit>();
  private head: string | null = null;
  private made = 0;
  private readonly interceptions: { match: (r: Received) => boolean; answer: Answer }[] = [];
  private readonly ready: Promise<void>;

  /** `files` null: an empty repository, with no commit at all. */
  constructor(files: Readonly<Record<string, string>> | null) {
    this.ready = files === null ? Promise.resolve() : this.seed(files);
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    await this.ready;
    const url = new URL(String(input));
    const request: Received = {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      headers: new Headers(init?.headers),
    };
    this.received.push(request);
    const index = this.interceptions.findIndex(({ match }) => match(request));
    if (index >= 0) {
      const [taken] = this.interceptions.splice(index, 1);
      return (taken as (typeof this.interceptions)[number]).answer(
        request,
        init?.signal ?? undefined,
      );
    }
    if (request.headers.get('Authorization') !== `Bearer ${FAKE_TOKEN}`)
      return refusal(401, 'Bad credentials');
    return this.route(request);
  };

  /** The next request `match` takes is answered by `answer` instead, once. */
  intercept(match: (request: Received) => boolean, answer: Answer): void {
    this.interceptions.push({ match, answer });
  }

  /** The next request `match` takes never answers until aborted; resolves when it arrives. */
  hang(match: (request: Received) => boolean): Promise<void> {
    return new Promise((arrived) =>
      this.intercept(match, (_request, signal) => {
        arrived();
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('aborted', 'AbortError'));
          if (signal?.aborted) abort();
          signal?.addEventListener('abort', abort);
        });
      }),
    );
  }

  /** Another device commits: `null` takes a path away. */
  async commitOutside(changes: Readonly<Record<string, string | null>>): Promise<void> {
    await this.ready;
    const entries = new Map(this.entriesAt(this.head));
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) entries.delete(path);
      else entries.set(path, { mode: '100644', sha: await this.putBlob(utf8(text)) });
    }
    await this.advance(entries, 'Outside');
  }

  /** The branch's files now, `{ path: text }`. */
  files(): Record<string, string> {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    return Object.fromEntries(
      [...this.entriesAt(this.head)].map(([path, { sha }]) => [
        path,
        decoder.decode(this.blobs.get(sha)),
      ]),
    );
  }

  /** The branch's commit messages, newest first. */
  history(): string[] {
    const messages: string[] = [];
    for (let at = this.head; at !== null;) {
      const commit = this.commitsBySha.get(at) as Commit;
      messages.push(commit.message);
      at = commit.parents[0] ?? null;
    }
    return messages;
  }

  /** Requests sent, as `METHOD path` without the repository prefix. */
  sentCalls(): string[] {
    return this.received.map(({ method, path }) => `${method} ${path.replace(REPO, '')}`);
  }

  private async seed(files: Readonly<Record<string, string>>): Promise<void> {
    const entries: Entries = new Map();
    for (const [path, text] of Object.entries(files))
      entries.set(path, { mode: '100644', sha: await this.putBlob(utf8(text)) });
    await this.advance(entries, 'Seed');
  }

  /** Commits `entries` on the head and moves the branch there; answers the new commit and tree. */
  private async advance(entries: Entries, message: string): Promise<{ sha: string; tree: string }> {
    const tree = await this.putTree(entries);
    const sha = await this.putCommit({
      tree,
      parents: this.head === null ? [] : [this.head],
      message,
    });
    this.head = sha;
    return { sha, tree };
  }

  private async putBlob(bytes: Uint8Array): Promise<string> {
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

  private async putCommit(commit: Commit): Promise<string> {
    const sha = await shaOfText(`commit ${++this.made} ${JSON.stringify(commit)}`);
    this.commitsBySha.set(sha, commit);
    return sha;
  }

  private entriesAt(commit: string | null): Entries {
    if (commit === null) return new Map();
    return this.trees.get((this.commitsBySha.get(commit) as Commit).tree) ?? new Map();
  }

  private route(request: Received): Response | Promise<Response> {
    const { method, path, body } = request;
    const ref = `/git/ref/heads/${FAKE_REPO.branch}`;
    const route = path.startsWith(REPO) ? path.slice(REPO.length) : null;
    if (route === null) return refusal(404, 'Not Found');
    if (method === 'GET' && route === '') return json(200, { full_name: REPO.slice(7) });
    if (method === 'GET' && route === ref) return this.readRef();
    const commit = /^\/git\/commits\/([0-9a-f]+)$/.exec(route);
    if (method === 'GET' && commit) return this.readCommit(commit[1] as string);
    const tree = /^\/git\/trees\/([0-9a-f]+)\?recursive=1$/.exec(route);
    if (method === 'GET' && tree) return this.listTree(tree[1] as string);
    const blob = /^\/git\/blobs\/([0-9a-f]+)$/.exec(route);
    if (method === 'GET' && blob) return this.readBlob(blob[1] as string);
    if (this.head === null && method !== 'PUT') return refusal(409, 'Git Repository is empty.');
    if (method === 'POST' && route === '/git/blobs') return this.createBlob(body);
    if (method === 'POST' && route === '/git/trees') return this.createTree(body);
    if (method === 'POST' && route === '/git/commits') return this.createCommit(body);
    if (method === 'PATCH' && route === `/git/refs/heads/${FAKE_REPO.branch}`)
      return this.updateRef(body);
    if (method === 'POST' && route === '/git/refs') return this.createRef(body);
    const contents = /^\/contents\/(.+)$/.exec(route);
    if (method === 'PUT' && contents)
      return this.putContents(decodeURIComponent(contents[1] as string), body);
    return refusal(404, 'Not Found');
  }

  private readRef(): Response {
    if (this.head === null) return refusal(409, 'Git Repository is empty.');
    return json(200, {
      ref: `refs/heads/${FAKE_REPO.branch}`,
      object: { type: 'commit', sha: this.head },
    });
  }

  private readCommit(sha: string): Response {
    const commit = this.commitsBySha.get(sha);
    if (commit === undefined) return refusal(404, 'Not Found');
    return json(200, {
      sha,
      tree: { sha: commit.tree },
      parents: commit.parents.map((p) => ({ sha: p })),
    });
  }

  private listTree(sha: string): Response {
    const entries = this.trees.get(sha);
    if (entries === undefined) return refusal(404, 'Not Found');
    const folders = new Set<string>();
    for (const path of entries.keys()) {
      const segments = path.split('/').slice(0, -1);
      segments.forEach((_, end) => folders.add(segments.slice(0, end + 1).join('/')));
    }
    const listed = [
      ...[...folders].map((path) => ({ path, mode: '040000', type: 'tree', sha })),
      ...[...entries].map(([path, entry]) => ({
        path,
        mode: entry.mode,
        type: 'blob',
        sha: entry.sha,
      })),
    ].sort((a, b) => (a.path < b.path ? -1 : 1));
    const truncated = this.truncateTrees;
    this.truncateTrees = false;
    return json(200, { sha, tree: truncated ? listed.slice(0, 1) : listed, truncated });
  }

  private readBlob(sha: string): Response {
    const bytes = this.blobs.get(sha);
    if (bytes === undefined) return refusal(404, 'Not Found');
    const content = (bytesToBase64(bytes).match(/.{1,60}/g) ?? []).join('\n');
    return json(200, { sha, size: bytes.byteLength, content: `${content}\n`, encoding: 'base64' });
  }

  private async createBlob(body: unknown): Promise<Response> {
    const { content, encoding } = body as { content?: unknown; encoding?: unknown };
    const bytes =
      typeof content === 'string' && encoding === 'base64' ? base64ToBytes(content) : null;
    if (bytes === null) return refusal(422, 'Invalid request');
    return json(201, { sha: await this.putBlob(bytes) });
  }

  private async createTree(body: unknown): Promise<Response> {
    const { base_tree: base, tree } = body as { base_tree?: string; tree?: unknown };
    const based = base === undefined ? new Map() : this.trees.get(base);
    if (based === undefined || !Array.isArray(tree)) return refusal(422, 'Invalid tree info');
    const entries: Entries = new Map(based);
    for (const raw of tree as { path: string; mode: string; type: string; sha: string | null }[]) {
      if (raw.type !== 'blob') return refusal(422, 'Invalid tree info');
      if (raw.sha === null) {
        if (!entries.delete(raw.path)) return refusal(422, `${raw.path} is not in the tree`);
      } else if (!this.blobs.has(raw.sha)) return refusal(422, 'Invalid tree info');
      else entries.set(raw.path, { mode: raw.mode, sha: raw.sha });
    }
    return json(201, { sha: await this.putTree(entries) });
  }

  private async createCommit(body: unknown): Promise<Response> {
    const { message, tree, parents } = body as {
      message?: unknown;
      tree?: string;
      parents?: string[];
    };
    if (typeof message !== 'string' || tree === undefined || !this.trees.has(tree))
      return refusal(422, 'Invalid commit');
    if (!Array.isArray(parents) || parents.some((parent) => !this.commitsBySha.has(parent)))
      return refusal(422, 'Invalid parent');
    return json(201, { sha: await this.putCommit({ tree, parents, message }) });
  }

  private updateRef(body: unknown): Response {
    const { sha, force } = body as { sha?: string; force?: boolean };
    if (sha === undefined || !this.commitsBySha.has(sha))
      return refusal(422, 'Object does not exist');
    if (force !== false || !this.descends(sha, this.head as string))
      return refusal(422, 'Update is not a fast forward');
    this.head = sha;
    return json(200, { ref: `refs/heads/${FAKE_REPO.branch}`, object: { type: 'commit', sha } });
  }

  private createRef(body: unknown): Response {
    const { ref, sha } = body as { ref?: string; sha?: string };
    if (
      ref !== `refs/heads/${FAKE_REPO.branch}` ||
      sha === undefined ||
      !this.commitsBySha.has(sha)
    )
      return refusal(422, 'Invalid request');
    if (this.head !== null) return refusal(422, 'Reference already exists');
    this.head = sha;
    return json(201, { ref, object: { type: 'commit', sha } });
  }

  private async putContents(path: string, body: unknown): Promise<Response> {
    const { message, content, branch } = body as {
      message?: string;
      content?: string;
      branch?: string;
    };
    if (this.head !== null)
      return refusal(422, 'Only an empty repository is started this way here');
    const bytes = typeof content === 'string' ? base64ToBytes(content) : null;
    if (bytes === null || typeof message !== 'string' || branch !== FAKE_REPO.branch)
      return refusal(422, 'Invalid request');
    const made = await this.advance(
      new Map([[path, { mode: '100644', sha: await this.putBlob(bytes) }]]),
      message,
    );
    return json(201, { commit: { sha: made.sha, tree: { sha: made.tree } } });
  }

  private descends(commit: string, ancestor: string): boolean {
    if (commit === ancestor) return true;
    return (this.commitsBySha.get(commit)?.parents ?? []).some((parent) =>
      this.descends(parent, ancestor),
    );
  }
}
