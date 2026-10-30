import { describe, expect, it } from 'vitest';
import {
  AUTOMATIONS_MAC_KEY,
  GITIGNORE_PATH,
  SYNC_KEY,
  SYNC_KEY_VALUE,
  VAULT_SETTINGS_PATH,
  withManagedIgnores,
} from '@dfai/domain';
import { recordingActivity } from '../testing/fake-activity.ts';
import {
  failed,
  memoryVault,
  memorySyncFiles,
  said,
  scriptedFolders,
  scriptedGit,
  statusText,
  type GitScript,
} from '../testing/fake-git.ts';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { inspectSync } from './inspect-sync.ts';
import { openVaultFromGitHub } from './open-from-github.ts';
import { ProgramMissingError, type GitResult } from './ports.ts';
import { setUpSync, type SetUpMac, type SyncRemoteChoice } from './set-up-sync.ts';
import { loadSyncSettings, saveSyncSettings } from './sync-settings.ts';

const clock = { now: () => 5, localNow: () => '2026-09-28T09:00:00' };
const NOT_A_REPO = failed(
  'fatal: not a git repository (or any of the parent directories): .git',
  128,
);
const MAC: SetUpMac = { name: 'Studio', id: 'mac-studio' };
/** A `.gitignore` with Atlas's managed block: half of what marks a vault set up (A29-01). */
const MANAGED_GITIGNORE = withManagedIgnores(null);
/** A settings note saying `sync: github`: the other half of Atlas's mark. */
const SYNCED_SETTINGS = '---\nsync: github\n---\n';

function prepare({
  script = {},
  files = {},
  parentTop,
  settingsSay = {},
}: {
  script?: GitScript;
  files?: Record<string, string>;
  parentTop?: GitResult;
  /** What the vault's settings note says once the first sync has brought it in. */
  settingsSay?: Record<string, unknown>;
} = {}) {
  const vault = memoryVault(files);
  const { git, called } = scriptedGit({ script, vault: vault.files });
  const folders = scriptedFolders(parentTop === undefined ? {} : { topLevelOf: parentTop });
  const { port: syncFiles } = memorySyncFiles();
  const saved: Record<string, unknown>[] = [];
  const activity = recordingActivity();
  const ports = {
    git,
    folders,
    fs: vault.fs,
    markdown: fakeMarkdown(),
    files: syncFiles,
    unsaved: { flushAll: async () => {} },
    activity,
    settings: {
      save: async (changes: Record<string, unknown>) => void saved.push(changes),
      update: async () => {},
    },
    // As the settings note reads after what was saved to it.
    readSettings: async () => Object.assign({}, settingsSay, ...saved),
    // Read only for a settings note a first sync copied aside, which these fakes never make.
    readSettingsCopy: async () => ({}),
  };
  const setUp = (remote: SyncRemoteChoice) =>
    setUpSync({ ports, vaultRoot: '/Users/j/Notes', remote, mac: MAC, clock });
  return { setUp, called, files: vault.files, saved, activity };
}

describe('setUpSync', () => {
  it('leaves the automations with the Mac an existing repository’s settings already name (A29-01)', async () => {
    const { setUp, saved } = prepare({
      script: { topLevel: NOT_A_REPO },
      settingsSay: { [AUTOMATIONS_MAC_KEY]: 'mac-laptop' },
    });
    await setUp({ kind: 'existing', url: 'git@github.com:j/notes.git' });
    expect(saved.some((changes) => AUTOMATIONS_MAC_KEY in changes)).toBe(false);
  });

  it('starts a repository, writes the managed .gitignore, names this Mac for automations, and creates a private GitHub repository', async () => {
    const { setUp, called, files, saved, activity } = prepare({
      script: {
        topLevel: NOT_A_REPO,
        status: [said(statusText({ upstream: null, changed: ['.gitignore', 'Today.md'] }))],
      },
      files: { 'Today.md': '# Today' },
    });
    await setUp({ kind: 'new-github', name: 'notes' });
    expect(called('init')).toHaveLength(1);
    expect(files.get('.gitignore')).toContain('.atlas-cache/');
    // Written once, before the first commit: the sync mark and this Mac,
    // named for the automations since no Mac has them yet.
    expect(saved).toEqual([
      { [SYNC_KEY]: SYNC_KEY_VALUE, automationsMac: 'mac-studio', automationsMacName: 'Studio' },
    ]);
    expect(called('commit')[0]?.args).toMatchObject({ message: 'Atlas sync set up on Studio' });
    expect(called('createGitHubRepository').map(({ args }) => args)).toEqual(['notes']);
    expect(activity.reports.at(-1)?.message).toContain('Sync set up');
  });

  it('keeps the person’s own .gitignore lines and does not start a second repository', async () => {
    const { setUp, called, files } = prepare({
      // A repository of its own with no origin yet: one with an origin is refused (issue #8).
      script: { topLevel: said('/Users/j/Notes\n'), remoteUrl: failed('error: No such remote', 2) },
      files: { '.gitignore': '*.tmp\n' },
    });
    await setUp({ kind: 'new-github', name: 'notes' });
    expect(called('init')).toHaveLength(0);
    expect(files.get('.gitignore')?.startsWith('*.tmp\n')).toBe(true);
    expect(files.get('.gitignore')).toContain('# >>> Atlas sync');
  });

  it('connects an existing repository by its address, then syncs its notes in', async () => {
    const { setUp, called } = prepare({
      script: {
        topLevel: NOT_A_REPO,
        remoteUrl: failed('', 2),
        // A freshly connected branch has no upstream tracked yet, so git
        // cannot compare it — which is also why the first sync always
        // merges, rather than seeing nothing behind and skipping it.
        status: said(statusText({ upstream: null })),
      },
    });
    const report = await setUp({ kind: 'existing', url: ' git@github.com:j/notes.git ' });
    expect(called('setRemote').map(({ args }) => args)).toEqual([
      { url: 'git@github.com:j/notes.git', exists: false },
    ]);
    expect(called('createGitHubRepository')).toHaveLength(0);
    expect(called('merge')).toHaveLength(1);
    expect(report.at).toBe(5);
  });

  it('follows the existing repository’s default branch when it differs from this Mac’s', async () => {
    const { setUp, called } = prepare({
      script: {
        topLevel: NOT_A_REPO,
        remoteUrl: failed('', 2),
        remoteHead: said('ref: refs/heads/master\tHEAD\n'),
      },
    });
    await setUp({ kind: 'existing', url: 'git@github.com:j/notes.git' });
    expect(called('renameBranch').map(({ args }) => args)).toEqual(['master']);
  });

  it('does not rename the branch when the repository’s default already matches', async () => {
    const { setUp, called } = prepare({
      script: { topLevel: NOT_A_REPO, remoteUrl: failed('', 2) },
    });
    await setUp({ kind: 'existing', url: 'git@github.com:j/notes.git' });
    expect(called('renameBranch')).toHaveLength(0);
  });

  it('names this Mac for automations only after the first sync of an existing repository', async () => {
    const { setUp, saved } = prepare({
      script: { topLevel: NOT_A_REPO, remoteUrl: failed('', 2) },
    });
    await setUp({ kind: 'existing', url: 'git@github.com:j/notes.git' });
    // Review A29-01 [M1]: Atlas's mark goes in before the first sync, so a
    // first sync cut off on a merge still leaves the vault reading as set up.
    expect(saved).toEqual([
      { [SYNC_KEY]: SYNC_KEY_VALUE },
      { automationsMac: 'mac-studio', automationsMacName: 'Studio' },
    ]);
  });

  it('refuses a vault inside another repository — the Atlas code, say — before writing anything', async () => {
    const { setUp, called, files, saved, activity } = prepare({
      script: { topLevel: said('/Users/j/Projects/atlas\n') },
      parentTop: said('/Users/j/Projects/atlas\n'),
    });
    await expect(setUp({ kind: 'new-github', name: 'notes' })).rejects.toThrow(
      'inside another git repository (atlas)',
    );
    expect(called('init')).toHaveLength(0);
    expect(called('commit')).toHaveLength(0);
    expect(files.has('.gitignore')).toBe(false);
    expect(saved).toEqual([]);
    expect(activity.reports[0]).toMatchObject({ level: 'error', kind: 'sync' });
  });

  it('refuses a repository name gh would not take, and an address git should not use', async () => {
    const { setUp, called } = prepare();
    await expect(setUp({ kind: 'new-github', name: '-rf' })).rejects.toThrow('letters, numbers');
    await expect(setUp({ kind: 'existing', url: 'ext::sh -c x' })).rejects.toThrow(
      'not an address git can use',
    );
    expect(called('topLevel')).toHaveLength(0);
  });

  it('will not set up over a merge left half done', async () => {
    const { setUp } = prepare({
      script: {
        topLevel: said('/Users/j/Notes\n'),
        status: said(statusText({ conflicts: [{ path: 'a.md', code: 'UU' }] })),
      },
    });
    await expect(setUp({ kind: 'new-github', name: 'notes' })).rejects.toThrow('middle of a merge');
  });

  it('says how to get gh when it is not installed', async () => {
    const { setUp } = prepare({
      script: {
        topLevel: NOT_A_REPO,
        createGitHubRepository: () => {
          throw new ProgramMissingError('gh');
        },
      },
    });
    await expect(setUp({ kind: 'new-github', name: 'notes' })).rejects.toThrow('brew install gh');
  });

  // Issue #8: marked before gh ran, a vault whose repository was never made
  // read as set up, and synced to whatever origin it had.
  it('marks the vault set up only once GitHub has the repository', async () => {
    const savedWhenCreated: number[] = [];
    const ready = prepare({
      script: {
        topLevel: NOT_A_REPO,
        createGitHubRepository: () => {
          savedWhenCreated.push(ready.saved.length);
          return said('');
        },
      },
    });
    await ready.setUp({ kind: 'new-github', name: 'notes' });
    expect(savedWhenCreated).toEqual([0]);
    expect(ready.saved).toEqual([
      { [SYNC_KEY]: SYNC_KEY_VALUE, automationsMac: 'mac-studio', automationsMacName: 'Studio' },
    ]);
  });

  it('leaves nothing that reads as set up when GitHub’s repository could not be made', async () => {
    const { setUp, saved } = prepare({
      script: { topLevel: NOT_A_REPO, createGitHubRepository: failed('HTTP 502: Bad Gateway') },
    });
    await expect(setUp({ kind: 'new-github', name: 'notes' })).rejects.toThrow();
    expect(saved).toEqual([]);
  });

  it('refuses a new repository for a vault that already sends somewhere, before writing anything', async () => {
    const { setUp, called, files, saved } = prepare({
      script: { topLevel: said('/Users/j/Notes\n'), remoteUrl: said('git@github.com:j/old.git\n') },
    });
    await expect(setUp({ kind: 'new-github', name: 'notes' })).rejects.toThrow(
      'This vault already sends to git@github.com:j/old.git',
    );
    expect(called('createGitHubRepository')).toHaveLength(0);
    expect(called('commit')).toHaveLength(0);
    expect(files.has('.gitignore')).toBe(false);
    expect(saved).toEqual([]);
  });

  it('explains a name already taken on GitHub', async () => {
    const { setUp } = prepare({
      script: {
        topLevel: NOT_A_REPO,
        createGitHubRepository: failed(
          'GraphQL: Name already exists on this account (createRepository)',
        ),
      },
    });
    await expect(setUp({ kind: 'new-github', name: 'notes' })).rejects.toThrow(
      'already have a repository with that name',
    );
  });
});

describe('inspectSync', () => {
  /** The notes `inspectSync` reads: `.gitignore` and the settings note, both Atlas's mark by default. */
  function notesFs(overrides: Record<string, string | null> = {}) {
    const notes: Record<string, string> = {
      [GITIGNORE_PATH]: MANAGED_GITIGNORE,
      [VAULT_SETTINGS_PATH]: SYNCED_SETTINGS,
    };
    for (const [path, text] of Object.entries(overrides)) {
      if (text === null) delete notes[path];
      else notes[path] = text;
    }
    return fakeVaultFs({
      readNotes: async (paths) =>
        paths.flatMap((path) => {
          const text = notes[path];
          return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
        }),
    });
  }

  const inspect = (
    script: GitScript,
    {
      parentTop,
      notes = {},
    }: { parentTop?: GitResult; notes?: Record<string, string | null> } = {},
  ) => {
    const { git } = scriptedGit({ script });
    const folders = scriptedFolders(parentTop === undefined ? {} : { topLevelOf: parentTop });
    return inspectSync({
      git,
      folders,
      fs: notesFs(notes),
      markdown: fakeMarkdown(),
      vaultRoot: '/Users/j/Notes',
    });
  };

  it('is set up when the vault is its own repository with an origin, its .gitignore is managed and its settings say so', async () => {
    await expect(inspect({ status: said(statusText({ behind: 3 })) })).resolves.toEqual({
      kind: 'set-up',
      remote: 'git@github.com:j/notes.git',
      behind: 3,
    });
  });

  it('is not set up without a repository or without an origin', async () => {
    await expect(inspect({ topLevel: NOT_A_REPO })).resolves.toEqual({ kind: 'not-set-up' });
    await expect(inspect({ remoteUrl: failed('error: No such remote', 2) })).resolves.toEqual({
      kind: 'not-set-up',
    });
  });

  it('is not set up in its own repository with an origin, but no Atlas mark — a code project, or a vault kept with obsidian-git', async () => {
    // The settings say sync: github, but nothing wrote Atlas's managed block:
    // an ordinary .gitignore is not Atlas's mark on its own.
    await expect(inspect({}, { notes: { [GITIGNORE_PATH]: '*.tmp\n' } })).resolves.toEqual({
      kind: 'not-set-up',
    });
    // The block is there, but the settings never said sync: github.
    await expect(inspect({}, { notes: { [VAULT_SETTINGS_PATH]: '---\n---\n' } })).resolves.toEqual({
      kind: 'not-set-up',
    });
    // Neither is there at all — a vault with no .gitignore and no settings note.
    await expect(
      inspect({}, { notes: { [GITIGNORE_PATH]: null, [VAULT_SETTINGS_PATH]: null } }),
    ).resolves.toEqual({ kind: 'not-set-up' });
  });

  it('is refused inside another repository', async () => {
    const setup = await inspect({ topLevel: said('/code\n') }, { parentTop: said('/code\n') });
    expect(setup.kind).toBe('refused');
  });

  it('knows nothing of how far behind when status cannot be read', async () => {
    await expect(inspect({ status: failed('boom') })).resolves.toMatchObject({ behind: 0 });
  });
});

describe('openVaultFromGitHub', () => {
  const location = { absolutePath: '/Users/j/Documents/', name: 'Documents' };
  const run = (folders = scriptedFolders({ picked: location })) => {
    const written: unknown[] = [];
    const order: string[] = [];
    const result = openVaultFromGitHub({
      folders,
      store: { read: async () => null, write: async (at) => void written.push(at) },
      url: 'https://github.com/j/My-Notes.git',
      openVault: '/Users/j/Notes',
      beforeSwitch: async () => void order.push('settled'),
    });
    return { result, written, order, folders };
  };

  it('clones into a folder named for the repository, and opens it', async () => {
    const { result, written, folders, order } = run();
    const opened = { absolutePath: '/Users/j/Documents/My-Notes', name: 'My-Notes' };
    await expect(result).resolves.toEqual(opened);
    expect(folders.clones).toEqual([
      { url: 'https://github.com/j/My-Notes.git', folder: '/Users/j/Documents/', name: 'My-Notes' },
    ]);
    expect(written).toEqual([opened]);
    expect(order).toEqual(['settled']);
  });

  it('does nothing when the folder picker is dismissed', async () => {
    const { result, folders } = run(scriptedFolders({ picked: null }));
    await expect(result).resolves.toBeNull();
    expect(folders.clones).toEqual([]);
  });

  it('refuses a folder inside another repository', async () => {
    const { result, folders } = run(
      scriptedFolders({ picked: location, topLevelOf: said('/Users/j/Projects/atlas\n') }),
    );
    await expect(result).rejects.toThrow('inside another git repository');
    expect(folders.clones).toEqual([]);
  });

  it('says why a clone failed and opens nothing', async () => {
    const { result, written } = run(
      scriptedFolders({ picked: location, clone: failed('ERROR: Repository not found.') }),
    );
    await expect(result).rejects.toThrow('can’t find that repository');
    expect(written).toEqual([]);
  });

  // Issue #8: the open vault picked as the folder, the copy went inside it and
  // was opened in its place.
  it('refuses the open vault, or a folder in it, before copying anything', async () => {
    for (const picked of ['/Users/j/Atlas Vault', '/Users/j/Atlas Vault/Chats']) {
      const folders = scriptedFolders({ picked: { absolutePath: picked, name: 'x' } });
      const written: unknown[] = [];
      let left = false;
      await expect(
        openVaultFromGitHub({
          folders,
          store: { read: async () => null, write: async (at) => void written.push(at) },
          url: 'https://github.com/j/pkm-space.git',
          openVault: '/Users/j/Atlas Vault',
          beforeSwitch: async () => void (left = true),
        }),
      ).rejects.toThrow('Settings → Sync');
      expect(folders.clones).toEqual([]);
      expect(written).toEqual([]);
      expect(left).toBe(false);
    }
  });

  // Issue #8: an empty repository opened as an empty vault in place of the open one.
  it('refuses an empty repository before copying anything', async () => {
    const { result, written, folders } = run(
      scriptedFolders({ picked: location, branchesAt: said('') }),
    );
    await expect(result).rejects.toThrow('This repository is empty');
    await expect(result).rejects.toThrow('Settings → Sync');
    expect(folders.clones).toEqual([]);
    expect(written).toEqual([]);
  });

  // Issue #8: the host hands back the folder picked as the disk spells it;
  // the open vault, as it was opened, may be spelled through a link.
  it('refuses the open vault by where it is on disk, however it was opened', async () => {
    const folders = scriptedFolders({
      picked: { absolutePath: '/private/var/j/Atlas Vault/Chats', name: 'Chats' },
      // As macOS resolves it: /var is a link to /private/var.
      onDisk: (folder) => folder.replace(/^\/var\//, '/private/var/'),
    });
    await expect(
      openVaultFromGitHub({
        folders,
        store: { read: async () => null, write: async () => {} },
        url: 'https://github.com/j/pkm-space.git',
        openVault: '/var/j/Atlas Vault',
      }),
    ).rejects.toThrow('the vault you have open');
    expect(folders.clones).toEqual([]);
  });

  it('refuses an address before asking for a folder', async () => {
    let asked = false;
    await expect(
      openVaultFromGitHub({
        folders: {
          ...scriptedFolders(),
          pickCloneFolder: async () => ((asked = true), null),
        },
        store: { read: async () => null, write: async () => {} },
        url: '--upload-pack=touch x',
        openVault: null,
      }),
    ).rejects.toThrow();
    expect(asked).toBe(false);
  });
});

describe('sync settings', () => {
  it('reads the pull interval, the push delay and the automations Mac, with defaults', async () => {
    const markdown = {
      ...fakeMarkdown(),
      frontmatterProperties: () => ({
        syncInterval: 15,
        syncPushDelay: 90,
        automationsMac: 'mac-studio',
        automationsMacName: 'Studio',
      }),
      frontmatterProblem: () => null,
    };
    const fs = fakeVaultFs({
      readNotes: async () => [
        { path: '.atlas/settings.md', text: '---\n---\n', modified: 1, size: 1 },
      ],
    });
    await expect(loadSyncSettings({ fs, markdown })).resolves.toEqual({
      pullIntervalMinutes: 15,
      pushDelaySeconds: 90,
      automationsMac: 'mac-studio',
      automationsMacName: 'Studio',
    });
    await expect(loadSyncSettings({ fs: fakeVaultFs(), markdown })).resolves.toEqual({
      pullIntervalMinutes: 1,
      pushDelaySeconds: 30,
      automationsMac: null,
      automationsMacName: null,
    });
  });

  it('writes only what changed, each bound to what it accepts', async () => {
    const saved: unknown[] = [];
    const settings = {
      save: async (changes: Record<string, unknown>) => void saved.push(changes),
      update: async () => {},
    };
    await saveSyncSettings({ settings, changes: { pullIntervalMinutes: 500 } });
    await saveSyncSettings({ settings, changes: { pushDelaySeconds: 1 } });
    // Who runs the automations is the claim's alone (#176): a stray key is never written.
    const stray = { automationsMac: 'mac-laptop', automationsMacName: 'Laptop' };
    await saveSyncSettings({ settings, changes: stray as never });
    expect(saved).toEqual([{ syncInterval: 120 }, { syncPushDelay: 5 }, {}]);
  });
});
