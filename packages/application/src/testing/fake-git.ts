import { createVaultPath, parentVaultPath, vaultPathName, type VaultEntry } from '@dfai/domain';
import {
  FileChangedError,
  type GitFoldersPort,
  type GitPort,
  type GitResult,
  type SyncFileName,
  type SleepClockPort,
  type SyncFilesPort,
} from '../sync/ports.ts';
import type { VaultFsPort, VaultLocation } from '../vault/ports.ts';

export const OK: GitResult = { code: 0, stdout: '', stderr: '' };
export const said = (stdout: string): GitResult => ({ code: 0, stdout, stderr: '' });
export const failed = (stderr: string, code = 1): GitResult => ({ code, stdout: '', stderr });

/** `git status -z` output, from the parts a test cares about. */
export function statusText({
  branch = 'main',
  upstream = 'origin/main' as string | null,
  ahead = 0,
  behind = 0,
  changed = [] as readonly string[],
  untracked = [] as readonly string[],
  conflicts = [] as readonly {
    path: string;
    code: string;
    /**
     * The blobs this conflict's sides carry, when a test settles it and cares
     * what is written where: `writeFromIndex` looks a copy's text up by its
     * blob, so two conflicts with different "theirs" text need different
     * ones. Falls back to {@link CONFLICT_BLOBS}, the same for every entry,
     * when a test only cares that a conflict exists.
     */
    oursOid?: string;
    theirsOid?: string;
  }[],
} = {}): string {
  const hash = 'a'.repeat(40);
  const records = [`# branch.oid ${hash}`, `# branch.head ${branch}`];
  if (upstream !== null)
    records.push(`# branch.upstream ${upstream}`, `# branch.ab +${ahead} -${behind}`);
  // What is changed is staged, as it is once `add --all` has run.
  for (const path of changed) {
    records.push(`1 M. N... 100644 100644 100644 ${hash} ${hash} ${path}`);
  }
  for (const path of untracked) records.push(`? ${path}`);
  for (const { path, code, oursOid, theirsOid } of conflicts) {
    const [defaultBase, defaultOurs, defaultTheirs] = CONFLICT_BLOBS;
    const present = CONFLICT_SIDES[code] ?? { base: true, ours: true, theirs: true };
    const side = (has: boolean, oid: string) =>
      has ? { mode: '100644', oid } : { mode: '0'.repeat(6), oid: '0'.repeat(40) };
    const base = side(present.base, defaultBase);
    const ours = side(present.ours, oursOid ?? defaultOurs);
    const theirs = side(present.theirs, theirsOid ?? defaultTheirs);
    records.push(
      `u ${code} N... ${base.mode} ${ours.mode} ${theirs.mode} ${ours.mode} ${base.oid} ${ours.oid} ${theirs.oid} ${path}`,
    );
  }
  return records.map((record) => `${record}\0`).join('');
}

/**
 * Which sides a conflict code says have the file at all — git's own
 * `DD`/`AU`/`UD`/`UA`/`DU`/`AA`/`UU`, read the way `conflict-copy.ts` reads
 * them: a mode of all zeros is git's way of saying a side has no file.
 */
const CONFLICT_SIDES: Readonly<Record<string, { base: boolean; ours: boolean; theirs: boolean }>> =
  {
    UU: { base: true, ours: true, theirs: true },
    AA: { base: false, ours: true, theirs: true },
    UD: { base: true, ours: true, theirs: false },
    AU: { base: false, ours: true, theirs: false },
    DU: { base: true, ours: false, theirs: true },
    UA: { base: false, ours: false, theirs: true },
    DD: { base: true, ours: false, theirs: false },
  };

/** The blobs `statusText` gives a conflict's base, this Mac's side, and the other's. */
export const CONFLICT_BLOBS = ['b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)] as const;

/** A vault's files in memory: what the sync's file port reads and moves. */
export function memoryVault(files: Record<string, string> = {}) {
  const contents = new Map(Object.entries(files));
  const folders = new Set<string>();
  const trashed: string[] = [];
  const entriesOf = (folder: string): VaultEntry[] => {
    const names = new Map<string, 'file' | 'directory'>();
    const inside = (path: string) =>
      folder === '' ? path : path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : null;
    for (const [path, kind] of [
      ...[...contents.keys()].map((path) => [path, 'file'] as const),
      ...[...folders].map((path) => [path, 'directory'] as const),
    ]) {
      const rest = inside(path);
      if (rest === null || rest === '') continue;
      const [first = '', ...more] = rest.split('/');
      names.set(first, more.length > 0 ? 'directory' : kind);
    }
    return [...names].map(([name, kind]) => {
      const path = createVaultPath(folder === '' ? name : `${folder}/${name}`);
      return kind === 'file' ? { kind, name, path, modified: 0, size: 0 } : { kind, name, path };
    }) as VaultEntry[];
  };
  /** A folder stays when its last file leaves, as on disk. */
  const keepFoldersOf = (path: string) => {
    for (let folder = parentVaultPath(createVaultPath(path)); folder !== '';) {
      folders.add(folder);
      folder = parentVaultPath(folder);
    }
  };
  const hasFolder = (folder: string) =>
    folder === '' ||
    folders.has(folder) ||
    [...contents.keys()].some((p) => p.startsWith(`${folder}/`));
  const fs: Pick<
    VaultFsPort,
    | 'listDirectory'
    | 'createFolder'
    | 'moveEntry'
    | 'trashEntry'
    | 'readTextFile'
    | 'writeTextFile'
    | 'createNote'
  > = {
    listDirectory: async (path) => {
      if (!hasFolder(path)) throw new Error('no such folder');
      return entriesOf(path);
    },
    createFolder: async ({ path }) => {
      if (hasFolder(path) || contents.has(path))
        throw new Error('something with that name is already there');
      if (!hasFolder(parentVaultPath(path))) throw new Error('that folder does not exist');
      folders.add(path);
    },
    moveEntry: async ({ from, to }) => {
      const text = contents.get(from);
      if (text === undefined) throw new Error(`no such entry: ${from}`);
      if (contents.has(to)) throw new Error('something with that name is already there');
      if (!hasFolder(parentVaultPath(to)))
        throw new Error(`that folder does not exist: ${vaultPathName(to)}`);
      keepFoldersOf(from);
      contents.delete(from);
      contents.set(to, text);
    },
    trashEntry: async ({ path }) => {
      keepFoldersOf(path);
      if (!contents.delete(path)) throw new Error(`no such entry: ${path}`);
      trashed.push(path);
    },
    readTextFile: async (path) => {
      const text = contents.get(path);
      if (text === undefined) throw new Error('no such file');
      return { text, modified: 1 };
    },
    writeTextFile: async ({ path, contents: text }) => {
      contents.set(path, text);
      return 2;
    },
    createNote: async ({ path, contents: text }) => {
      if (contents.has(path)) throw new Error('already there');
      contents.set(path, text);
      return 2;
    },
  };
  return { fs, files: contents, trashed };
}

/** A blob id for text, as git's would be: 40 hex digits, the same for the same text. */
export function fakeBlob(text: string): string {
  let hash = 0x811c9dc5;
  for (const character of text) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').repeat(5);
}

/** The sync's own files (journal and excludes), in memory. */
export function memorySyncFiles(initial: Partial<Record<SyncFileName, string>> = {}) {
  const files = new Map<SyncFileName, string>(Object.entries(initial) as [SyncFileName, string][]);
  const port: SyncFilesPort = {
    read: async (name) => files.get(name) ?? null,
    write: async (name, contents) => {
      if (contents === null) files.delete(name);
      else files.set(name, contents);
    },
  };
  return { port, files };
}

/**
 * The host's sleep counter (#172): how long the Mac has slept since it
 * booted, moved only by a test sleeping it. `unreadable` makes every read
 * fail, as the host's would off macOS.
 */
export function fakeSleepClock(asleepMs = 457_335_000) {
  let asleep = asleepMs;
  let readable = true;
  let reads = 0;
  const port: SleepClockPort = {
    asleepMs: async () => {
      reads += 1;
      if (!readable) throw new Error('the clocks could not be read');
      return asleep;
    },
  };
  return {
    port,
    sleep: (ms: number) => void (asleep += ms),
    unreadable: (yes = true) => void (readable = !yes),
    reads: () => reads,
  };
}

type Answer = GitResult | ((...args: never[]) => GitResult);
export type GitScript = Partial<Record<keyof GitPort, Answer | Answer[]>>;

/**
 * Git as a script: each method answers from `script` — one answer, a list
 * taken in turn (the last repeats), or a function — and every call is
 * recorded. `sides` makes checkout write each side's text into the vault, as
 * git does, so a test sees what a conflict left in the files; the same map
 * backs `stageBlob` + `writeFromIndex`, so a conflict's copy is written with
 * its actual text too, and — like real `checkout-index` — never over a file
 * already there.
 */
export function scriptedGit({
  script = {},
  vault,
  sides = {},
}: {
  script?: GitScript;
  vault?: Map<string, string>;
  sides?: Record<string, { base?: string; ours: string; theirs: string }>;
} = {}) {
  const calls: { method: keyof GitPort; args: unknown }[] = [];
  const turns = new Map<string, number>();
  // What `stageBlob` put in the index, and the text behind every blob a
  // conflict's sides carry, so `writeFromIndex` can write a copy's text
  // without knowing which conflict it came from — exactly what real git's
  // index does for `checkout-index`.
  const staged = new Map<string, string>();
  const movedTo = new Set<string>();
  const blobsByOid = new Map<string, string>();
  for (const side of Object.values(sides)) {
    if (side.base !== undefined) blobsByOid.set(fakeBlob(side.base), side.base);
    blobsByOid.set(fakeBlob(side.ours), side.ours);
    blobsByOid.set(fakeBlob(side.theirs), side.theirs);
  }
  const answer = (method: keyof GitPort, args: unknown, fallback: GitResult): GitResult => {
    calls.push({ method, args });
    const scripted = script[method];
    if (scripted === undefined) return fallback;
    const list = Array.isArray(scripted) ? scripted : [scripted];
    const turn = turns.get(method) ?? 0;
    turns.set(method, turn + 1);
    const chosen = list[Math.min(turn, list.length - 1)] as Answer;
    return typeof chosen === 'function' ? (chosen as (args: unknown) => GitResult)(args) : chosen;
  };
  const git: GitPort = {
    topLevel: async () => answer('topLevel', null, said('/vault\n')),
    init: async () => answer('init', null, OK),
    status: async () => answer('status', null, said(statusText())),
    addAll: async () => answer('addAll', null, OK),
    commit: async (args) => answer('commit', args, OK),
    fetch: async () => answer('fetch', null, OK),
    merge: async (args) => answer('merge', args, OK),
    push: async () => answer('push', null, OK),
    remoteUrl: async () => answer('remoteUrl', null, said('git@github.com:j/notes.git\n')),
    setRemote: async (args) => answer('setRemote', args, OK),
    currentBranch: async () => answer('currentBranch', null, said('main\n')),
    head: async () => answer('head', null, said('abc\u0000100\n')),
    mergeInProgress: async () => answer('mergeInProgress', null, failed('', 1)),
    remoteSubject: async (branch) =>
      answer('remoteSubject', branch, said('DFAI sync from Laptop 2026-09-28 13:00\n')),
    remoteBranchExists: async (branch) => answer('remoteBranchExists', branch, OK),
    // As the host does, writes only over the file the sync saw (#246).
    checkout: async (args) => {
      const now = vault?.get(args.path);
      if (vault !== undefined && args.seen !== (now === undefined ? null : fakeBlob(now))) {
        calls.push({ method: 'checkout', args });
        throw new FileChangedError(`changed: ${args.path} changed since the sync looked at it`);
      }
      const result = answer('checkout', args, OK);
      const side = sides[args.path];
      if (side !== undefined && vault !== undefined) vault.set(args.path, side[args.side]);
      return result;
    },
    config: async (key) => answer('config', key, said('James\n')),
    createGitHubRepository: async (name) => answer('createGitHubRepository', name, OK),
    untrackedExact: async () => answer('untrackedExact', null, said('')),
    // The index, as far as the fake knows it: the vault's files, what was
    // staged under a new name, and where a file was moved to.
    indexEntries: async () => {
      const paths = new Set([...(vault?.keys() ?? []), ...staged.keys(), ...movedTo]);
      const entries = [...paths].map(
        (path) => `100644 ${staged.get(path) ?? fakeBlob(path)} 0\t${path}\0`,
      );
      return answer('indexEntries', null, said(entries.join('')));
    },
    move: async (args) => {
      movedTo.add(args.to);
      return answer('move', args, OK);
    },
    tree: async (rev) => answer('tree', rev, said('')),
    mergeBase: async (branch) => answer('mergeBase', branch, said('')),
    hashFile: async (path) => {
      const text = vault?.get(path);
      return answer(
        'hashFile',
        path,
        text === undefined ? failed('no such file', 128) : said(`${fakeBlob(text)}\n`),
      );
    },
    readBlob: async (oid) => {
      const text = blobsByOid.get(oid);
      return answer('readBlob', oid, text === undefined ? failed('not a blob', 128) : said(text));
    },
    // GitHub holds no settings note unless a test says what it holds.
    remoteSettings: async (branch) =>
      answer(
        'remoteSettings',
        branch,
        failed(`fatal: path '.atlas/settings.md' does not exist in 'origin/${branch}'`, 128),
      ),
    stageBlob: async (args) => {
      staged.set(args.path, args.oid);
      return answer('stageBlob', args, OK);
    },
    writeFromIndex: async (path) => {
      if (vault?.has(path)) {
        // Real `checkout-index` refuses to write over a file already there.
        return answer('writeFromIndex', path, failed('fatal: already exists, no checkout', 128));
      }
      const text = blobsByOid.get(staged.get(path) ?? '');
      if (text !== undefined) vault?.set(path, text);
      return answer('writeFromIndex', path, OK);
    },
    untrack: async (path) => answer('untrack', path, OK),
    unstage: async (path) => answer('unstage', path, OK),
    resetSoftTo: async (branch) => answer('resetSoftTo', branch, OK),
    largeUnpushed: async (bytes) => answer('largeUnpushed', bytes, said('')),
    remoteHead: async () => answer('remoteHead', null, said('ref: refs/heads/main\tHEAD\n')),
    renameBranch: async (name) => answer('renameBranch', name, OK),
  };
  const called = (method: keyof GitPort) => calls.filter((call) => call.method === method);
  return { git, calls, called };
}

/** A folders port whose parent is in no repository, and whose clone succeeds, unless told otherwise. */
export function scriptedFolders(
  answers: {
    topLevelOf?: GitResult;
    clone?: GitResult;
    /** What the host's folder dialog answers with; dismissed when null. */
    picked?: VaultLocation | null;
    /** What `ls-remote --heads` lists; one branch unless told otherwise. */
    branchesAt?: GitResult;
    /** How the host spells a folder on disk, every link resolved; as given unless told. */
    onDisk?: (folder: string) => string;
  } = {},
): GitFoldersPort & { readonly clones: unknown[] } {
  const clones: unknown[] = [];
  return {
    clones,
    pickCloneFolder: async () =>
      answers.picked === undefined ? { absolutePath: '/Users/j', name: 'j' } : answers.picked,
    topLevelOf: async () => answers.topLevelOf ?? failed('fatal: not a git repository', 128),
    onDisk: async (folder) => (answers.onDisk ?? ((given: string) => given))(folder),
    branchesAt: async () => answers.branchesAt ?? said('39e8579\trefs/heads/main\n'),
    clone: async (args) => {
      clones.push(args);
      return answers.clone ?? OK;
    },
  };
}
