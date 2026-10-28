/**
 * Two simulated Macs sharing one bare remote, synced by the real `syncNow`
 * running the Mac's real git (with the host's fixed prefix and ceiling) over
 * the real disk. The invariant under attack (U-29): no note, attachment or
 * setting is ever lost or left holding conflict markers, and every divergent
 * version survives somewhere visible.
 *
 * Deterministic: a fixed clock, fixed Mac names, an isolated HOME, no sleeps.
 * A "kill" is a step that never returns: the sync is abandoned there, exactly
 * as a quit would leave it, and a fresh sync is run over what it left.
 */
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, onTestFinished } from 'vitest';
import { createVaultPath, VAULT_ROOT, type SyncReport } from '@dfai/domain';
import {
  createUnsettledSaid,
  EntryChangedError,
  fakeVaultFs,
  syncNow,
  type GitPort,
  type GitResult,
  type SyncFilesPort,
  type SyncPorts,
  type VaultFsPort,
} from '@dfai/application';
import { gitCommands, remarkMarkdown } from '@dfai/adapters';

const run = promisify(execFile);
export const TIMEOUT = 60_000;
export const clock = { now: () => 1_000, localNow: () => '2026-09-28T14:05:00' };
export const MARKERS = /^(<<<<<<<|>>>>>>>) /m;

/** What `git_process.rs` puts before every run (`FIXED_PREFIX`). */
const PREFIX = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=false',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'color.ui=never',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
  '-c',
  'merge.ff=true',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.safecrlf=false',
  '-c',
  'merge.conflictStyle=merge',
  '-c',
  'merge.renames=true',
  '--literal-pathspecs',
  '--no-optional-locks',
];

export type Env = NodeJS.ProcessEnv;

export async function sh(cwd: string, args: readonly string[], env: Env): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run('git', [...PREFIX, ...args], {
      cwd,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }
}

export async function must(cwd: string, args: readonly string[], env: Env): Promise<string> {
  const result = await sh(cwd, args, env);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/**
 * The host's GitPort: the adapter's own argument shapes, run as `git_run`
 * runs them — the fixed prefix, the vault's excludes file in place of the
 * Mac's, and git never looking above the vault.
 */
export function realGit(root: string, env: Env, { github }: { github?: string } = {}): GitPort {
  const ceiling = { ...env, GIT_CEILING_DIRECTORIES: dirname(root) };
  const excludes = join(root, '.git', 'atlas-sync', 'exclude');
  const git = (...args: string[]) =>
    sh(root, ['-c', `core.excludesFile=${excludes}`, ...args], ceiling);
  return {
    ...gitCommands(git),
    createGitHubRepository: async (name) =>
      github === undefined
        ? { code: 1, stdout: '', stderr: 'no gh in tests' }
        : ghRepoCreate({ root, env: ceiling, bare: join(github, `${name}.git`) }),
  };
}

/**
 * `gh repo create <name> --private --source=. --remote=origin --push`, as it
 * behaves: a new repository on "GitHub" (a bare one on disk, which refuses
 * files over GitHub's limit as GitHub does), `origin` pointed at it, and
 * the branch pushed — all through the vault's own git, as gh does.
 */
async function ghRepoCreate({ root, env, bare }: { root: string; env: Env; bare: string }) {
  await mkdir(dirname(bare), { recursive: true });
  const made = await sh(
    dirname(bare),
    ['init', '--quiet', '--bare', '--initial-branch=main', bare],
    env,
  );
  if (made.code !== 0) return made;
  await refuseFilesOverGitHubsLimit(bare);
  const added = await sh(root, ['remote', 'add', 'origin', bare], env);
  if (added.code !== 0) return added;
  return sh(root, ['push', '--quiet', '--set-upstream', 'origin', 'HEAD'], env);
}

/** The host's sync files, in the vault's `.git/atlas-sync/`, as `write_sync_file` keeps them. */
export function realSyncFiles(root: string): SyncFilesPort {
  const folder = join(root, '.git', 'atlas-sync');
  return {
    read: (name) => readFile(join(folder, name), 'utf8').catch(() => null),
    write: async (name, contents) => {
      if (contents === null) {
        await rm(join(folder, name), { force: true });
        return;
      }
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, `.${name}.tmp`), contents);
      await rename(join(folder, `.${name}.tmp`), join(folder, name));
    },
  };
}

/** The most bytes the host reads as text (`MAX_TEXT_BYTES` in vault.rs). */
const MAX_TEXT_BYTES = 10 * 1024 * 1024;

type RealFs = Pick<
  VaultFsPort,
  | 'listDirectory'
  | 'createFolder'
  | 'moveEntry'
  | 'trashEntry'
  | 'readTextFile'
  | 'readNotes'
  | 'createNote'
  | 'writeTextFile'
>;

/** The host's vault file commands, with the refusals `vault.rs` and `vault_entries.rs` make. */
export function realFs(root: string, trash: string): RealFs {
  const at = (path: string) => join(root, path);
  let trashed = 0;
  const readTextFile: RealFs['readTextFile'] = async (path) => {
    const facts = await stat(at(path));
    if (facts.isDirectory()) throw new Error('that is a directory');
    if (facts.size > MAX_TEXT_BYTES) throw new Error('larger than the limit');
    const bytes = await readFile(at(path));
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('not a text file');
    }
    return { text, modified: facts.mtimeMs };
  };
  return {
    listDirectory: async (path) => {
      const entries = await readdir(at(path), { withFileTypes: true });
      const listed = [];
      for (const entry of entries) {
        const child = path === VAULT_ROOT ? entry.name : `${path}/${entry.name}`;
        // As the host does: metadata follows links, a broken one is skipped.
        const facts = await stat(at(child)).catch(() => null);
        if (facts === null) continue;
        listed.push(
          facts.isDirectory()
            ? { kind: 'directory' as const, name: entry.name, path: createVaultPath(child) }
            : {
                kind: 'file' as const,
                name: entry.name,
                path: createVaultPath(child),
                modified: facts.mtimeMs,
                size: facts.size,
              },
        );
      }
      return listed;
    },
    createFolder: async ({ path }) => {
      await mkdir(at(path));
    },
    moveEntry: async ({ from, to }) => {
      const source = await lstat(at(from));
      const target = await lstat(at(to)).catch(() => null);
      if (target !== null && target.ino !== source.ino) {
        throw new Error('something with that name is already there');
      }
      await rename(at(from), at(to));
    },
    // As `vault_entries.rs` does (#235): nothing moves unless each file named is as it was read.
    trashEntry: async ({ path, unchanged = [] }) => {
      for (const file of unchanged) {
        const now = await readTextFile(file.path).catch(() => null);
        if (now?.modified !== file.modified || now.text !== file.text) {
          throw new EntryChangedError(`${file.path} changed on disk since it was read`);
        }
      }
      trashed += 1;
      await rename(at(path), join(trash, `${trashed}`));
    },
    readTextFile,
    // As the host does: a file that is not there, or not text, is left out.
    readNotes: async (paths) => {
      const notes = [];
      for (const path of paths) {
        const read = await readTextFile(createVaultPath(path)).catch(() => null);
        if (read !== null) notes.push({ path, text: read.text, modified: read.modified, size: 0 });
      }
      return notes;
    },
    createNote: async ({ path, contents }) => {
      await writeFile(at(path), contents, { flag: 'wx' });
      return (await stat(at(path))).mtimeMs;
    },
    writeTextFile: async ({ path, contents }) => {
      await writeFile(at(path), contents);
      return (await stat(at(path))).mtimeMs;
    },
  };
}

/**
 * A Mac's files as the whole vault port, for the settings writer: the
 * methods it uses are the real ones above; the rest, which it never calls, do nothing.
 */
export function vaultFsOf(mac: Pick<Mac, 'fs'>): VaultFsPort {
  return fakeVaultFs(mac.fs);
}

export type Contents = string | Uint8Array;

export interface Mac {
  readonly name: string;
  readonly root: string;
  readonly git: GitPort;
  readonly fs: RealFs;
  readonly syncFiles: SyncFilesPort;
  readonly activity: string[];
  sync(overrides?: {
    git?: Partial<GitPort>;
    fs?: Partial<SyncPorts['fs']>;
    flushAll?: () => Promise<void>;
    /** Asked before every step the sync takes through a port; a promise it returns is what that step does instead. */
    intercept?: Intercept;
  }): Promise<SyncReport>;
  write(path: string, contents: Contents): Promise<void>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  /** Every file in the vault outside `.git`, as it is spelled on disk, with its bytes. */
  files(): Promise<Map<string, Buffer>>;
}

async function walk(root: string, folder = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
    const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
    // The vault's repository, and that of a folder in it that is one of its own.
    if (entry.name === '.git') continue;
    if (entry.isDirectory()) out.push(...(await walk(root, path)));
    else out.push(path);
  }
  return out;
}

/**
 * What a test does at one step of a sync: nothing (null), or a promise the
 * step becomes — one that never settles is the app quitting there.
 */
export type Intercept = (step: string) => Promise<never> | null;

/** The port, with every method asked of `intercept` first, as `<port>.<method>`. */
export function intercepted<Port extends object>(
  port: Port,
  name: string,
  intercept: Intercept | undefined,
): Port {
  if (intercept === undefined) return port;
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(port)) {
    wrapped[key] =
      typeof value === 'function'
        ? (...args: unknown[]) =>
            intercept(`${name}.${key}`) ?? (value as (...rest: unknown[]) => unknown)(...args)
        : value;
  }
  return wrapped as Port;
}

export function macAt({
  name,
  root,
  env,
  trash,
  github,
}: {
  name: string;
  root: string;
  env: Env;
  trash: string;
  /** Where `gh repo create` makes repositories; without it, gh fails. */
  github?: string;
}): Mac {
  const git = realGit(root, env, github === undefined ? {} : { github });
  const fs = realFs(root, trash);
  const syncFiles = realSyncFiles(root);
  const activity: string[] = [];
  // What this Mac has said of copies it kept, for the session, as the app holds it.
  const copiesSaid = createUnsettledSaid();
  return {
    name,
    root,
    git,
    fs,
    syncFiles,
    activity,
    sync: (overrides = {}) =>
      syncNow({
        ports: {
          git: intercepted({ ...git, ...overrides.git }, 'git', overrides.intercept),
          fs: intercepted({ ...fs, ...overrides.fs }, 'fs', overrides.intercept),
          files: intercepted(syncFiles, 'files', overrides.intercept),
          markdown: remarkMarkdown,
          unsaved: intercepted(
            { flushAll: overrides.flushAll ?? (async () => {}) },
            'unsaved',
            overrides.intercept,
          ),
          activity: { record: (line) => activity.push(`${line.level}: ${line.message}`) },
          copiesSaid,
        },
        mac: name,
        clock,
      }),
    write: async (path, contents) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    },
    read: (path) => readFile(join(root, path), 'utf8'),
    remove: (path) => rm(join(root, path), { recursive: true }),
    move: (from, to) => rename(join(root, from), join(root, to)),
    files: async () => {
      const map = new Map<string, Buffer>();
      for (const path of await walk(root)) map.set(path, await readFile(join(root, path)));
      return map;
    },
  };
}

export async function isolatedWorld() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'atlas-two-macs-')));
  // Issue #397: left behind, a night of runs filled the disk. Runs whether the test passed or not.
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const trash = join(base, 'trash');
  await mkdir(home);
  await mkdir(trash);
  // The machine's git settings (in place of the real Mac's): git's housekeeping
  // after a push, fetch or commit runs inside that command rather than in a
  // detached process left writing into the world as it is removed (#477). It
  // goes here, not in `env`, because git drops config from the environment when
  // it starts the remote's side of a push to a path; and not in `home`, which
  // is the person's own `.gitconfig`, for the tests to write.
  const machineConfig = join(base, 'gitconfig');
  await writeFile(
    machineConfig,
    '[maintenance]\n\tautoDetach = false\n[gc]\n\tautoDetach = false\n',
  );
  const env: Env = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_SYSTEM: machineConfig,
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
  };
  const bare = join(base, 'github', 'vault.git');
  await mkdir(dirname(bare), { recursive: true });
  return { base, home, trash, env, bare };
}

/** Studio sets the vault up with `files` on `branch` and pushes; Laptop clones it. */
export async function twoMacs(
  files: Record<string, Contents>,
  { branch = 'main', gitconfig }: { branch?: string; gitconfig?: string } = {},
) {
  const world = await isolatedWorld();
  const { base, env, bare, trash, home } = world;
  await must(base, ['init', '--quiet', '--bare', `--initial-branch=${branch}`, bare], env);
  const studioRoot = join(base, 'Studio', 'vault');
  await mkdir(studioRoot, { recursive: true });
  await must(studioRoot, ['init', '--quiet', `--initial-branch=${branch}`], env);
  const studio = macAt({ name: 'Studio', root: studioRoot, env, trash });
  for (const [path, contents] of Object.entries(files)) await studio.write(path, contents);
  await must(studioRoot, ['add', '--all'], env);
  await must(
    studioRoot,
    [
      '-c',
      'user.name=Seed',
      '-c',
      'user.email=seed@x',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'seed',
    ],
    env,
  );
  await must(studioRoot, ['remote', 'add', 'origin', bare], env);
  await must(studioRoot, ['push', '--quiet', '--set-upstream', 'origin', 'HEAD'], env);
  const laptopRoot = join(base, 'Laptop', 'vault');
  await mkdir(dirname(laptopRoot), { recursive: true });
  await must(
    dirname(laptopRoot),
    ['clone', '--quiet', '--origin', 'origin', '--', bare, 'vault'],
    env,
  );
  const laptop = macAt({ name: 'Laptop', root: laptopRoot, env, trash });
  // The Macs' own git settings, in place from here on, as they are for the app.
  if (gitconfig !== undefined) await writeFile(join(home, '.gitconfig'), gitconfig);
  return { ...world, studio, laptop };
}

/** GitHub's own rule, as a pre-receive hook on the bare remote: no file over 100 MB. */
export async function refuseFilesOverGitHubsLimit(bare: string): Promise<void> {
  await writeFile(
    join(bare, 'hooks', 'pre-receive'),
    [
      '#!/bin/sh',
      'while read old new ref; do',
      '  for object in $(git rev-list --objects "$new" --not --all | cut -d" " -f1); do',
      '    if [ "$(git cat-file -t "$object")" = blob ] && [ "$(git cat-file -s "$object")" -gt 104857600 ]; then',
      '      echo "remote: error: File exceeds GitHub\'s file size limit of 100.00 MB" >&2; exit 1',
      '    fi',
      '  done',
      'done',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

/** Every file's text on a Mac, for looking for versions and markers. */
export async function texts(mac: Mac): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const [path, bytes] of await mac.files()) map.set(path, bytes.toString('latin1'));
  return map;
}

export async function expectNoMarkers(mac: Mac): Promise<void> {
  const marked = [...(await texts(mac))].filter(([, text]) => MARKERS.test(text)).map(([p]) => p);
  expect(marked, `files on ${mac.name} holding conflict markers`).toEqual([]);
}

/** Each version is the whole of some file on the Mac. */
export async function expectVersionsSurvive(
  mac: Mac,
  versions: readonly Contents[],
): Promise<void> {
  const files = [...(await mac.files()).values()];
  for (const version of versions) {
    const wanted = typeof version === 'string' ? Buffer.from(version) : Buffer.from(version);
    const found = files.some((bytes) => bytes.equals(wanted));
    expect(
      found,
      `a file on ${mac.name} holding ${JSON.stringify(String(version).slice(0, 60))}`,
    ).toBe(true);
  }
}

/** A step that never returns — the app quit there — and a promise that says it was reached. */
export function killPoint() {
  let reached: () => void = () => {};
  const hit = new Promise<void>((resolve) => (reached = resolve));
  const hang = <T>(): Promise<T> => {
    reached();
    return new Promise<T>(() => {});
  };
  return { hit, hang };
}

/** Both Macs change `path` from `base`; Studio's reaches GitHub first. */
export async function bothChange(
  path: string,
  { base, studio: mine, laptop: theirs }: { base: Contents; studio: Contents; laptop: Contents },
  options?: Parameters<typeof twoMacs>[1],
) {
  const world = await twoMacs({ [path]: base }, options);
  await world.studio.write(path, mine);
  await world.studio.sync();
  await world.laptop.write(path, theirs);
  return world;
}
