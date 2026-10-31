/**
 * Issue #8, attacked: the ways a person can still end up with the open vault
 * switched, emptied, or silently not syncing after the clone-folder fix.
 * Each test names one invariant and runs the real git against bare
 * repositories on disk standing in for GitHub, with `gh` faked by the harness.
 */
import { mkdir, readdir, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSettingsWriter,
  inspectSync,
  openVaultFromGitHub,
  readVaultSettings,
  setUpSync,
  type GitFoldersPort,
  type SyncRemoteChoice,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import {
  clock,
  isolatedWorld,
  macAt,
  must,
  sh,
  TIMEOUT,
  vaultFsOf,
  type Env,
  type Mac,
} from './two-macs.harness.ts';

const VAULT: Record<string, string> = {
  'Test Note.md': 'a note\n',
  '.atlas/settings.md': '---\nquickAdd:\n  - task\n---\n\n# Settings\n',
  '.atlas/types/task.md': '---\nname: task\n---\n',
  '.atlas/views/Board.md': '---\nquery: select 1\n---\n',
};

function folders(env: Env, picked: string | null = null): GitFoldersPort {
  return {
    pickCloneFolder: async () =>
      picked === null ? null : { absolutePath: picked, name: picked.split('/').pop() ?? '' },
    topLevelOf: (folder) => sh(folder, ['rev-parse', '--show-toplevel'], env),
    clone: async ({ url, folder, name }) => sh(folder, ['clone', '--quiet', url, name], env),
    // As the host resolves a folder: std::fs::canonicalize, which realpath is.
    onDisk: (folder) => realpath(folder),
    branchesAt: ({ url, folder }) => sh(folder, ['ls-remote', '--heads', '--', url], env),
  };
}

async function setUp(mac: Mac, env: Env, remote: SyncRemoteChoice) {
  const settings = createSettingsWriter({ fs: vaultFsOf(mac), markdown: remarkMarkdown });
  return setUpSync({
    ports: {
      git: mac.git,
      folders: folders(env),
      fs: mac.fs,
      files: mac.syncFiles,
      markdown: remarkMarkdown,
      unsaved: { flushAll: async () => {} },
      activity: { record: (line) => mac.activity.push(`${line.level}: ${line.message}`) },
      settings,
      readSettings: () => readVaultSettings({ fs: mac.fs, markdown: remarkMarkdown }),
      readSettingsCopy: (path) => readVaultSettings({ fs: mac.fs, markdown: remarkMarkdown, path }),
    },
    vaultRoot: mac.root,
    remote,
    mac: { name: 'James’s MacBook Air', id: 'mac-air' },
    clock,
  });
}

async function jamesVault(base: string, env: Env, trash: string, github?: string) {
  const root = join(base, 'DFAI Vault');
  const mac = macAt({
    name: 'James’s MacBook Air',
    root,
    env,
    trash,
    ...(github ? { github } : {}),
  });
  for (const [path, contents] of Object.entries(VAULT)) await mac.write(path, contents);
  return mac;
}

function inspect(mac: Mac, env: Env) {
  return inspectSync({
    git: mac.git,
    folders: folders(env),
    fs: mac.fs,
    markdown: remarkMarkdown,
    vaultRoot: mac.root,
  });
}

async function pushedPaths(base: string, bare: string, env: Env): Promise<string[]> {
  const listing = await must(
    base,
    ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'],
    env,
  );
  return listing.split('\n').filter((line) => line !== '');
}

/** A vault already kept with obsidian-git: its own repository, with an `origin` of its own. */
async function obsidianGitVault(base: string, env: Env, trash: string, github: string) {
  const mac = await jamesVault(base, env, trash, github);
  const obsidianRemote = join(base, 'obsidian-backup.git');
  await must(base, ['init', '--quiet', '--bare', '--initial-branch=main', obsidianRemote], env);
  await must(mac.root, ['init', '--quiet', '--initial-branch=main'], env);
  await must(mac.root, ['remote', 'add', 'origin', obsidianRemote], env);
  return { mac, obsidianRemote };
}

describe('a new GitHub repository that could not be made leaves nothing set up (issue #8)', () => {
  it(
    'a vault with an origin of its own is not left "set up" against that origin when gh fails',
    async () => {
      const { base, env, trash } = await isolatedWorld();
      const { mac } = await obsidianGitVault(base, env, trash, join(base, 'github'));

      await expect(setUp(mac, env, { kind: 'new-github', name: 'pkm-space' })).rejects.toThrow();

      // Anything else makes the app sync — and push the vault — to the old remote on open.
      expect((await inspect(mac, env)).kind).not.toBe('set-up');
    },
    TIMEOUT,
  );

  it(
    'gh failing to add a remote is not reported as the repository name being taken',
    async () => {
      const { base, env, trash } = await isolatedWorld();
      const { mac } = await obsidianGitVault(base, env, trash, join(base, 'github'));

      const failure = setUp(mac, env, { kind: 'new-github', name: 'pkm-space' });

      // "Pick another name" makes a second stray repository on GitHub, and fails the same way.
      await expect(failure).rejects.toThrow(/.+/);
      await expect(failure).rejects.not.toThrow(/already have a repository with that name/);
    },
    TIMEOUT,
  );
});

describe('opening a vault from GitHub never trades the open vault for an empty one (issue #8)', () => {
  it(
    'an empty repository is refused, not opened as an empty vault in place of the open one',
    async () => {
      const { base, env, bare, trash } = await isolatedWorld();
      await must(base, ['init', '--quiet', '--bare', '--initial-branch=main', bare], env);
      const mac = await jamesVault(base, env, trash);
      const elsewhere = join(base, 'Elsewhere');
      await mkdir(elsewhere);
      const written: unknown[] = [];

      const opened = openVaultFromGitHub({
        folders: folders(env, elsewhere),
        store: { read: async () => null, write: async (at) => void written.push(at) },
        url: bare,
        openVault: mac.root,
      });

      // An empty repository holds no vault to open; the person meant Settings → Sync.
      await expect(opened).rejects.toThrow(/Settings → Sync/);
      expect(written).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'the open vault reached through a symlink is refused like the vault itself',
    async () => {
      const { base, env, bare, trash } = await isolatedWorld();
      await must(base, ['init', '--quiet', '--bare', '--initial-branch=main', bare], env);
      const mac = await jamesVault(base, env, trash);
      const alias = join(base, 'Notes');
      await symlink(mac.root, alias);

      const opened = openVaultFromGitHub({
        folders: folders(env, alias),
        store: { read: async () => null, write: async () => {} },
        url: bare,
        openVault: mac.root,
      });

      await expect(opened).rejects.toThrow(/vault you have open/);
      expect((await readdir(mac.root)).sort()).toEqual(['.atlas', 'Test Note.md']);
    },
    TIMEOUT,
  );
});

describe('every file in the vault reaches GitHub or is said not to (issue #8)', () => {
  it(
    'a line of the person’s own .gitignore that leaves out .atlas is reported, not silently obeyed',
    async () => {
      const { base, env, bare, trash } = await isolatedWorld();
      await must(base, ['init', '--quiet', '--bare', '--initial-branch=main', bare], env);
      const mac = await jamesVault(base, env, trash);
      await mac.write('.gitignore', '.atlas/\n');

      const report = await setUp(mac, env, { kind: 'existing', url: bare });

      const pushed = await pushedPaths(base, bare, env);
      const missing = Object.keys(VAULT).filter((path) => !pushed.includes(path));
      const said = [...report.notSynced, ...mac.activity].join('\n');
      for (const path of missing) expect(said).toContain(path.split('/').slice(0, 2).join('/'));
    },
    TIMEOUT,
  );
});

describe('connecting to a vault another Mac set up never takes its automations (issue #8)', () => {
  it(
    'the settings of both sides differing, the other Mac keeps the automations',
    async () => {
      const { base, env, bare, trash } = await isolatedWorld();
      await must(base, ['init', '--quiet', '--bare', '--initial-branch=main', bare], env);
      const studio = macAt({ name: 'Studio', root: join(base, 'studio'), env, trash });
      await studio.write(
        '.atlas/settings.md',
        '---\nsync: github\nautomationsMac: mac-studio\nautomationsMacName: Studio\n---\n\n# Settings\n',
      );
      await studio.write('Studio Note.md', 'from the studio\n');
      await must(studio.root, ['init', '--quiet', '--initial-branch=main'], env);
      await must(studio.root, ['add', '--all'], env);
      await must(
        studio.root,
        ['-c', 'user.name=S', '-c', 'user.email=s@x', 'commit', '--quiet', '-m', 'Studio'],
        env,
      );
      await must(studio.root, ['remote', 'add', 'origin', bare], env);
      await must(studio.root, ['push', '--quiet', '-u', 'origin', 'HEAD'], env);
      const mac = await jamesVault(base, env, trash);

      await setUp(mac, env, { kind: 'existing', url: bare });

      expect(await mac.read('.atlas/settings.md')).not.toMatch(/automationsMac: mac-air/);
    },
    TIMEOUT,
  );
});
