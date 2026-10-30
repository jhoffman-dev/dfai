import type { ConflictSide, GitIdentity, GitPort, GitResult, TreeRev } from '@dfai/application';
import { VAULT_SETTINGS_PATH } from '@dfai/domain';

/** Runs git with these arguments, in the vault, as the host does. */
export type RunGit = (...args: string[]) => Promise<GitResult>;

/** `checkout --ours|--theirs -- <path>`: one side of a conflicted file, written over it. */
export const checkoutArgs = (side: ConflictSide, path: string): string[] => [
  'checkout',
  `--${side}`,
  '--',
  path,
];

/** `-c user.name=… -c user.email=…`: who a commit or merge is by, when git has no one. */
const identityArgs = (identity: GitIdentity | null): string[] =>
  identity === null
    ? []
    : ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`];

/**
 * The other Macs' branch by its full name: the short `origin/<branch>` is
 * outranked by a local branch or tag of that spelling, and the host refuses
 * it (#630).
 */
const remoteBranch = (branch: string) => `refs/remotes/origin/${branch}`;

const revOf = (rev: TreeRev): string =>
  rev.kind === 'head' ? 'HEAD' : rev.kind === 'remote' ? remoteBranch(rev.branch) : rev.oid;

/**
 * The argument shapes of every git step a sync takes (U-29, A29-01), each
 * one the host holds fixed in `shapes.rs`: what the port's methods mean, as
 * git's own words. `gh` is not here; it has a host command of its own.
 */
export function gitCommands(git: RunGit): Omit<GitPort, 'createGitHubRepository'> {
  return {
    topLevel: () => git('rev-parse', '--show-toplevel'),
    init: () => git('init', '--quiet', '--initial-branch=main'),
    status: () => git('status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'),
    addAll: () => git('add', '--all'),
    commit: ({ message, identity }) =>
      git(...identityArgs(identity), 'commit', '--quiet', '--no-verify', '-m', message),
    fetch: () => git('fetch', '--quiet', 'origin'),
    merge: ({ branch, identity }) =>
      git(
        ...identityArgs(identity),
        'merge',
        '--no-edit',
        '--allow-unrelated-histories',
        remoteBranch(branch),
      ),
    push: () => git('push', '--quiet', '--set-upstream', 'origin', 'HEAD'),
    remoteUrl: () => git('remote', 'get-url', 'origin'),
    setRemote: ({ url, exists }) => git('remote', exists ? 'set-url' : 'add', 'origin', url),
    currentBranch: () => git('symbolic-ref', '--quiet', '--short', 'HEAD'),
    head: () => git('log', '-1', '--format=%H%x00%ct'),
    mergeInProgress: () => git('rev-parse', '--verify', '--quiet', 'MERGE_HEAD'),
    remoteSubject: (branch) => git('log', '-1', '--format=%s', remoteBranch(branch), '--'),
    remoteBranchExists: (branch) => git('rev-parse', '--verify', '--quiet', remoteBranch(branch)),
    // Drops `seen`: the guard lives in the host, and only `tauriGit`, which overrides this, runs in production.
    checkout: ({ side, path }) => git(...checkoutArgs(side, path)),
    config: (key) => git('config', '--get', key),
    untrackedExact: () =>
      git('-c', 'core.ignoreCase=false', 'ls-files', '-z', '--others', '--exclude-standard'),
    indexEntries: () => git('ls-files', '-z', '--stage'),
    move: ({ from, to }) => git('mv', '--', from, to),
    tree: (rev) => git('ls-tree', '-r', '-z', revOf(rev)),
    mergeBase: (branch) => git('merge-base', 'HEAD', remoteBranch(branch)),
    hashFile: (path) => git('hash-object', '--no-filters', '--', path),
    readBlob: (oid) => git('cat-file', 'blob', oid),
    remoteSettingsExist: (branch) =>
      git('cat-file', '-e', `${remoteBranch(branch)}:${VAULT_SETTINGS_PATH}`),
    remoteSettings: (branch) =>
      git('cat-file', 'blob', `${remoteBranch(branch)}:${VAULT_SETTINGS_PATH}`),
    stageBlob: ({ mode, oid, path }) =>
      git('update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`),
    writeFromIndex: (path) => git('checkout-index', '--', path),
    untrack: (path) => git('rm', '--cached', '--quiet', '--', path),
    unstage: (path) => git('reset', '--quiet', '--', path),
    resetSoftTo: (branch) => git('reset', '--quiet', '--soft', remoteBranch(branch)),
    largeUnpushed: (bytes) =>
      git(
        'rev-list',
        '--objects',
        `--filter=blob:limit=${bytes}`,
        '--filter-print-omitted',
        'HEAD',
        '--not',
        '--remotes=origin',
      ),
    remoteHead: () => git('ls-remote', '--symref', 'origin', 'HEAD'),
    renameBranch: (name) => git('branch', '-m', name),
  };
}
