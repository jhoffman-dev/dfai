/**
 * The web as a third writer of the two Macs' vault (#665): the GitHub vault
 * the web build runs, over the GitHub API stand-in, whose objects and branch
 * are the very bare repository the Macs push to and pull from. A web save is
 * a real commit on that branch, made with git's own plumbing, so the Macs'
 * real `syncNow` takes it as any other remote change.
 *
 * Deterministic: fixed commit dates, the harness's isolated HOME, and every
 * scratch file inside the world's own temp root.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createVaultPath, WEB_DEVICE, type VaultPath } from '@dfai/domain';
import {
  inVault,
  isChangedOnDiskRefusal,
  keepRefusedAsCopy,
  openNote,
  saveNote,
  type OpenNote,
  type VaultFsPort,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import {
  FakeGitHub,
  vaultOver,
  type Commit,
  type Entries,
  type GitObjects,
} from '@dfai/adapters/testing/github';
import type { Env } from './two-macs.harness.ts';

/** Who GitHub records as committing what the API is asked to commit. */
const COMMITTED = { GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' };
/** Commits made through the stand-in are dated at one fixed instant. */
const COMMIT_DATE = '2026-11-01T12:00:00Z';
/** The signed-in person, recorded as GitHub does when a commit names no author. */
const SIGNED_IN = { name: 'Mara Quill', email: 'mara@larkspur.invalid' };
const NO_COMMIT = '0'.repeat(40);

interface Ran {
  readonly code: number;
  readonly stdout: Buffer;
}

function git(
  bare: string,
  args: readonly string[],
  { env, input }: { env: Env; input?: Uint8Array | string },
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: bare, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out) }));
    child.stdin.end(input ?? '');
  });
}

async function must(
  bare: string,
  args: readonly string[],
  options: { env: Env; input?: Uint8Array | string },
) {
  const ran = await git(bare, args, options);
  if (ran.code !== 0) throw new Error(`git ${args.join(' ')} failed in the stand-in`);
  return ran.stdout;
}

const text = (bytes: Buffer) => bytes.toString('utf8').trim();

/** The type of the object `sha` names, or null when there is none. */
async function typeOf(bare: string, sha: string, env: Env): Promise<string | null> {
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  const ran = await git(bare, ['cat-file', '-t', sha], { env });
  return ran.code === 0 ? text(ran.stdout) : null;
}

function parseCommit(raw: string): Commit {
  const split = raw.indexOf('\n\n');
  const headers = raw.slice(0, split).split('\n');
  const field = (name: string) =>
    headers
      .filter((line) => line.startsWith(`${name} `))
      .map((line) => line.slice(name.length + 1));
  const author = /^(.*) <(.*)> \d+ [+-]\d{4}$/.exec(field('author')[0] ?? '');
  return {
    tree: field('tree')[0] ?? '',
    parents: field('parent'),
    // `commit-tree` ends a message with a newline the API never sent.
    message: raw.slice(split + 2).replace(/\n$/, ''),
    ...(author !== null && { author: { name: author[1]!, email: author[2]! } }),
  };
}

/** The stand-in's objects and branch, as a real bare repository holds them. */
export function bareRepositoryObjects({
  bare,
  branch,
  env,
  scratch,
}: {
  bare: string;
  branch: string;
  env: Env;
  /** A folder inside the world's temp root, for the index a tree is built in. */
  scratch: string;
}): GitObjects {
  const ref = `refs/heads/${branch}`;
  return {
    head: async () => {
      const ran = await git(bare, ['rev-parse', '--verify', '--quiet', ref], { env });
      return ran.code === 0 ? text(ran.stdout) : '';
    },
    moveHead: async ({ from, to }) =>
      (await git(bare, ['update-ref', ref, to, from === '' ? NO_COMMIT : from], { env })).code ===
      0,
    putBlob: async (bytes) =>
      text(await must(bare, ['hash-object', '-w', '--stdin'], { env, input: bytes })),
    blob: async (sha) =>
      (await typeOf(bare, sha, env)) === 'blob'
        ? new Uint8Array(await must(bare, ['cat-file', 'blob', sha], { env }))
        : undefined,
    putTree: (entries) => writeTree({ bare, env, scratch, entries }),
    tree: async (sha) => {
      if ((await typeOf(bare, sha, env)) !== 'tree') return undefined;
      const listed = (await must(bare, ['ls-tree', '-r', '-z', sha], { env })).toString('utf8');
      const entries = new Map<string, { mode: string; sha: string }>();
      for (const line of listed.split('\0').filter((entry) => entry !== '')) {
        const [meta = '', path = ''] = line.split('\t');
        const [mode = '', , blob = ''] = meta.split(' ');
        entries.set(path, { mode, sha: blob });
      }
      return entries;
    },
    putCommit: async ({ tree, parents, message, author = SIGNED_IN }) => {
      const dated = {
        ...env,
        ...COMMITTED,
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: COMMIT_DATE,
        GIT_COMMITTER_DATE: COMMIT_DATE,
      };
      const args = ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-F', '-'];
      return text(await must(bare, args, { env: dated, input: message }));
    },
    commit: async (sha) =>
      (await typeOf(bare, sha, env)) === 'commit'
        ? parseCommit((await must(bare, ['cat-file', 'commit', sha], { env })).toString('utf8'))
        : undefined,
  };
}

/** A tree of exactly `entries`, built in an index of its own so nothing else is touched. */
async function writeTree({
  bare,
  env,
  scratch,
  entries,
}: {
  bare: string;
  env: Env;
  scratch: string;
  entries: Entries;
}): Promise<string> {
  const folder = await mkdtemp(join(scratch, 'index-'));
  const indexed = { ...env, GIT_INDEX_FILE: join(folder, 'index') };
  try {
    await must(bare, ['read-tree', '--empty'], { env: indexed });
    const lines = [...entries].map(([path, { mode, sha }]) => `${mode} ${sha}\t${path}\0`).join('');
    await must(bare, ['update-index', '-z', '--index-info'], { env: indexed, input: lines });
    return text(await must(bare, ['write-tree'], { env: indexed }));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** What a web save came to: written, or refused and kept as a copy beside the note. */
export type WebSaved =
  { readonly kind: 'saved' } | { readonly kind: 'kept-as-copy'; readonly copy: VaultPath | null };

export interface WebWriter {
  readonly github: FakeGitHub;
  readonly fs: VaultFsPort;
  /** Opens a note as the web's editor does, holding the version it read. */
  open(path: string): Promise<OpenNote>;
  /**
   * Saves `body` over the version `opened` read. Refused because the note
   * moved on, it takes the second way out the editor offers — keep mine as
   * a conflict copy beside the newer version — as she would to lose nothing.
   */
  save(opened: OpenNote, body: string): Promise<WebSaved>;
}

/** The web, writing the Macs' remote at `bare` through the API stand-in. */
export function webWriter({
  bare,
  branch = 'main',
  env,
  scratch,
}: {
  bare: string;
  branch?: string;
  env: Env;
  scratch: string;
}): WebWriter {
  const github = new FakeGitHub({
    where: { owner: 'mara-quill', repo: 'larkspur-vault', branch },
    objects: bareRepositoryObjects({ bare, branch, env, scratch }),
  });
  const { fs: host, vault } = vaultOver(github);
  const fs = inVault({ fs: host, vault });
  const markdown = remarkMarkdown;
  return {
    github,
    fs,
    open: (path) => openNote({ fs, markdown, path: createVaultPath(path) }),
    save: async (opened, body) => {
      const doc = markdown.parseBody(body).doc;
      try {
        await saveNote({ fs, markdown, note: opened, doc });
        return { kind: 'saved' };
      } catch (error) {
        if (!isChangedOnDiskRefusal(error)) throw error;
        const copy = await keepRefusedAsCopy({
          fs,
          markdown,
          note: opened,
          doc,
          device: WEB_DEVICE,
        });
        return { kind: 'kept-as-copy', copy };
      }
    },
  };
}
