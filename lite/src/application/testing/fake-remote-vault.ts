import type { VaultPath } from '../../domain/vault/index.ts';
import {
  RemoteMovedError,
  type PushCommit,
  type RemoteEntry,
  type RemoteHead,
  type RemoteVault,
} from '../ports/index.ts';

/** A content hash standing in for git's sha-1: equal texts, equal shas. Not cryptographic. */
export function fakeSha(kind: string, content: string): string {
  let low = 0x811c9dc5;
  let high = 0x01000193;
  const input = `${kind} ${content}`;
  for (let at = 0; at < input.length; at += 1) {
    const code = input.charCodeAt(at);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ code, 0x811c9dc5) >>> 0;
  }
  return `${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

interface Commit {
  readonly treeSha: string;
  readonly parent: string | null;
  readonly message: string;
}

/**
 * A GitHub repository's branch in memory, behaving as the `RemoteVault`
 * port promises: content-addressed blobs, one tree per commit, pushes that
 * fail with `RemoteMovedError` when the parent is not the head. Tests can
 * push "from elsewhere", make the next call fail, and see what was fetched.
 */
export class FakeRemoteVault implements RemoteVault {
  private readonly blobStore = new Map<string, string>();
  private readonly trees = new Map<string, RemoteEntry[]>();
  private readonly commits = new Map<string, Commit>();
  private headSha: string;
  private nextFailure: Error | null = null;
  /** Every push accepted, in order. */
  readonly pushes: PushCommit[] = [];
  /** Every batch of shas `blobs` was asked for, in order. */
  readonly blobRequests: (readonly string[])[] = [];

  constructor(files: Readonly<Record<VaultPath, string>> = {}) {
    this.headSha = this.commit(this.treeOf(files), null, 'Initial commit');
  }

  /** The next call to any method fails with `error` (once). */
  failNext(error: Error): void {
    this.nextFailure = error;
  }

  /** Another device or Claude pushes: the branch moves on without this device. */
  pushFromElsewhere({
    upserts = {},
    deletes = [],
    message = 'Edit elsewhere',
  }: {
    upserts?: Readonly<Record<VaultPath, string>>;
    deletes?: readonly VaultPath[];
    message?: string;
  }): RemoteHead {
    const files = this.files();
    for (const path of deletes) delete files[path];
    Object.assign(files, upserts);
    this.headSha = this.commit(this.treeOf(files), this.headSha, message);
    return this.currentHead();
  }

  /** The branch's files now, `{ path: text }`. */
  files(): Record<VaultPath, string> {
    const tree = this.trees.get(this.currentHead().treeSha) ?? [];
    return Object.fromEntries(tree.map(({ path, sha }) => [path, this.blobStore.get(sha) ?? '']));
  }

  async head(): Promise<RemoteHead> {
    this.throwIfFailing();
    return this.currentHead();
  }

  async tree(treeSha: string): Promise<RemoteEntry[]> {
    this.throwIfFailing();
    const tree = this.trees.get(treeSha);
    if (tree === undefined) throw new Error(`No tree ${treeSha}.`);
    return tree.map((entry) => ({ ...entry }));
  }

  async blobs(shas: readonly string[]): Promise<Map<string, string>> {
    this.throwIfFailing();
    this.blobRequests.push([...shas]);
    const texts = new Map<string, string>();
    for (const sha of shas) {
      const text = this.blobStore.get(sha);
      if (text === undefined) throw new Error(`No blob ${sha}.`);
      texts.set(sha, text);
    }
    return texts;
  }

  async push(commit: PushCommit): Promise<RemoteHead> {
    this.throwIfFailing();
    if (commit.parentCommitSha !== this.headSha) throw new RemoteMovedError();
    const files = this.files();
    for (const path of commit.deletes) delete files[path];
    for (const { path, text } of commit.upserts) files[path] = text;
    this.headSha = this.commit(this.treeOf(files), this.headSha, commit.message);
    this.pushes.push(commit);
    return this.currentHead();
  }

  private currentHead(): RemoteHead {
    const commit = this.commits.get(this.headSha) as Commit;
    return { commitSha: this.headSha, treeSha: commit.treeSha };
  }

  private treeOf(files: Readonly<Record<VaultPath, string>>): string {
    const entries = Object.entries(files)
      .map(([path, text]) => {
        const sha = fakeSha('blob', text);
        this.blobStore.set(sha, text);
        return { path, sha };
      })
      .sort((left, right) => (left.path < right.path ? -1 : 1));
    const sha = fakeSha('tree', entries.map(({ path, sha: blob }) => `${blob} ${path}`).join('\n'));
    this.trees.set(sha, entries);
    return sha;
  }

  private commit(treeSha: string, parent: string | null, message: string): string {
    const sha = fakeSha('commit', `${treeSha}\n${parent ?? ''}\n${this.commits.size}\n${message}`);
    this.commits.set(sha, { treeSha, parent, message });
    return sha;
  }

  private throwIfFailing(): void {
    const failure = this.nextFailure;
    if (failure === null) return;
    this.nextFailure = null;
    throw failure;
  }
}
