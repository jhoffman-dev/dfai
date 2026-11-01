/**
 * Issue #8: setting up sync makes the vault that is open the repository —
 * in place, never a folder inside it — and a vault connected to a repository
 * that already has commits keeps every file it had. Run with the real git
 * against a bare repository on disk standing in for GitHub.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withManagedIgnores } from '@dfai/domain';
import {
  createSettingsWriter,
  inspectSync,
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
  MARKERS,
  must,
  sh,
  TIMEOUT,
  vaultFsOf,
  type Env,
  type Mac,
} from './two-macs.harness.ts';

const JAMES_SETTINGS = [
  '---',
  'quickAdd:',
  '  - task',
  '  - notes',
  'sidebarOrder:',
  '  - dashboards',
  '  - views',
  '---',
  '',
  '# Settings',
  '',
].join('\n');

/** What the stray setup commit on GitHub holds: DFAI's settings and nothing else. */
const SETUP_COMMIT_SETTINGS = [
  '---',
  'sync: github',
  'automationsMac: mac-air',
  'automationsMacName: James’s MacBook Air',
  '---',
  '',
  '# Settings',
  '',
].join('\n');

const VAULT: Record<string, string> = {
  'Test Note.md': 'a note\n',
  'Chats/Today.md': 'a chat\n',
  '.atlas/settings.md': JAMES_SETTINGS,
  '.atlas/types/task.md': '---\nname: task\n---\n',
  '.atlas/views/Board.md': '---\nquery: select 1\n---\n',
  '.atlas/automations/Archive.md': '---\nwhen: daily\n---\n',
  '.atlas-cache/index.sqlite': 'derived',
};

function folders(env: Env): GitFoldersPort {
  return {
    pickCloneFolder: async () => null,
    topLevelOf: (folder) => sh(folder, ['rev-parse', '--show-toplevel'], env),
    clone: async () => ({ code: 1, stdout: '', stderr: 'not in tests' }),
    onDisk: async () => {
      throw new Error('not in tests');
    },
    branchesAt: async () => ({ code: 1, stdout: '', stderr: 'not in tests' }),
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

async function pushedPaths(base: string, bare: string, env: Env): Promise<string[]> {
  const listing = await must(
    base,
    ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'],
    env,
  );
  return listing.split('\n').filter((line) => line !== '');
}

async function pushedText(base: string, bare: string, path: string, env: Env): Promise<string> {
  return must(base, ['--git-dir', bare, 'show', `main:${path}`], env);
}

/** The folders directly in the vault, so a subfolder made by set-up shows. */
async function topFolders(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const EVERY_VAULT_FILE = Object.keys(VAULT).filter((path) => !path.startsWith('.atlas-cache/'));

describe('setting up sync works on the open vault, in place (issue #8)', () => {
  it(
    'creates a new repository from the vault folder itself, and pushes every file but the cache',
    async () => {
      const { base, env, trash } = await isolatedWorld();
      const github = join(base, 'github');
      const mac = await jamesVault(base, env, trash, github);

      await setUp(mac, env, { kind: 'new-github', name: 'pkm-space' });

      expect(await topFolders(mac.root)).toEqual(['.atlas', '.atlas-cache', '.git', 'Chats']);
      expect(await must(mac.root, ['rev-parse', '--show-toplevel'], env)).toBe(`${mac.root}\n`);
      const pushed = await pushedPaths(base, join(github, 'pkm-space.git'), env);
      expect(pushed).toEqual(expect.arrayContaining([...EVERY_VAULT_FILE, '.gitignore']));
      expect(pushed.some((path) => path.startsWith('.atlas-cache'))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'connects an empty repository by its address in place, and pushes the vault to it',
    async () => {
      const { base, env, bare, trash } = await isolatedWorld();
      await must(base, ['init', '--quiet', '--bare', '--initial-branch=main', bare], env);
      const mac = await jamesVault(base, env, trash);

      await setUp(mac, env, { kind: 'existing', url: bare });

      expect(await topFolders(mac.root)).toEqual(['.atlas', '.atlas-cache', '.git', 'Chats']);
      expect(await pushedPaths(base, bare, env)).toEqual(
        expect.arrayContaining([...EVERY_VAULT_FILE, '.gitignore']),
      );
    },
    TIMEOUT,
  );

  it(
    'recovers James’s vault: connected to a repository holding only a setup commit, it keeps every file and pushes them',
    async () => {
      const { base, env, bare, trash } = await isolatedWorld();
      await must(base, ['init', '--quiet', '--bare', '--initial-branch=main', bare], env);
      // The stray clone's one commit: the managed .gitignore and DFAI's settings.
      const stray = join(base, 'stray');
      await mkdir(join(stray, '.atlas'), { recursive: true });
      await must(stray, ['init', '--quiet', '--initial-branch=main'], env);
      await writeFile(join(stray, '.gitignore'), withManagedIgnores(null));
      await writeFile(join(stray, '.atlas', 'settings.md'), SETUP_COMMIT_SETTINGS);
      await must(stray, ['add', '--all'], env);
      await must(
        stray,
        [
          '-c',
          'user.name=J',
          '-c',
          'user.email=j@x',
          'commit',
          '--quiet',
          '-m',
          'DFAI sync set up',
        ],
        env,
      );
      await must(stray, ['remote', 'add', 'origin', bare], env);
      await must(stray, ['push', '--quiet', '-u', 'origin', 'HEAD'], env);
      const mac = await jamesVault(base, env, trash);

      const report = await setUp(mac, env, { kind: 'existing', url: bare });

      // Every file is still there, with what it said.
      for (const [path, contents] of Object.entries(VAULT)) {
        if (path === '.atlas/settings.md') continue;
        expect(await mac.read(path)).toBe(contents);
      }
      // The vault's own settings win, with DFAI's sync keys written into them.
      // GitHub's version says nothing they do not, so it is merged by its keys
      // rather than kept as a copy under Sync conflicts (#233): nothing is lost.
      const settings = await mac.read('.atlas/settings.md');
      expect(settings).toMatch(/quickAdd:\n {2}- task\n {2}- notes/);
      expect(settings).toMatch(/sidebarOrder:/);
      expect(settings).toMatch(/sync: github/);
      expect(settings).toMatch(/automationsMac: mac-air/);
      expect(settings).toMatch(/automationsMacName: James’s MacBook Air/);
      expect(settings).not.toMatch(MARKERS);
      const copies = [...(await mac.files()).keys()].filter((path) =>
        path.startsWith('Sync conflicts/'),
      );
      expect(copies).toEqual([]);
      expect(report.pushed).toBe(true);
      expect(await pushedPaths(base, bare, env)).toEqual(
        expect.arrayContaining([...EVERY_VAULT_FILE, '.gitignore']),
      );
      expect(await readFile(join(mac.root, '.gitignore'), 'utf8')).toBe(withManagedIgnores(null));
      // A sync after it settles nothing and leaves nothing behind: GitHub
      // holds the vault's settings as they are here.
      await expect(mac.sync()).resolves.toMatchObject({ conflicts: [] });
      expect(await pushedText(base, bare, '.atlas/settings.md', env)).toBe(settings);
      expect(await must(mac.root, ['status', '--porcelain'], env)).toBe('');
      const setup = await inspectSync({
        git: mac.git,
        folders: folders(env),
        fs: mac.fs,
        markdown: remarkMarkdown,
        vaultRoot: mac.root,
      });
      expect(setup.kind).toBe('set-up');
    },
    TIMEOUT,
  );

  it(
    'leaves a folder that is a repository of its own out, and says plainly what to do about it',
    async () => {
      const { base, env, bare, trash } = await isolatedWorld();
      await must(base, ['init', '--quiet', '--bare', '--initial-branch=main', bare], env);
      const mac = await jamesVault(base, env, trash);
      const nested = join(mac.root, 'pkm-space');
      await mkdir(nested);
      await writeFile(join(nested, '.gitignore'), withManagedIgnores(null));
      await must(nested, ['init', '--quiet', '--initial-branch=main'], env);

      const report = await setUp(mac, env, { kind: 'existing', url: bare });

      const pushed = await pushedPaths(base, bare, env);
      // Not a gitlink, and not its files either.
      expect(pushed.some((path) => path.startsWith('pkm-space'))).toBe(false);
      expect(report.notSynced).toContain('pkm-space/');
      expect(mac.activity.join('\n')).toMatch(
        /warning: pkm-space\/? is a git repository of its own.*(move|delete)/i,
      );
    },
    TIMEOUT,
  );
});
