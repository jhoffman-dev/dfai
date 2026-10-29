import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileChangedError, ProgramMissingError } from '@dfai/application';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { tauriGit, tauriGitFolders, tauriGitHub, tauriMacName, tauriSyncFiles } =
  await import('./tauri-git.ts');

const OUTPUT = { code: 0, stdout: 'ok', stderr: '' };

describe('tauriGit', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(OUTPUT);
  });

  it('runs each step as the one argument shape the host allows, naming its vault', async () => {
    const git = tauriGit('/v');
    await git.status();
    await git.commit({ message: 'DFAI sync', identity: null });
    await git.commit({ message: 'm', identity: { name: 'DFAI on Mac', email: 'a@b' } });
    await git.merge({ branch: 'main', identity: null });
    await git.merge({ branch: 'main', identity: { name: 'DFAI on Mac', email: 'a@b' } });
    await git.remoteBranchExists('main');
    await git.checkout({ side: 'theirs', path: 'Ideas.md', seen: null });
    await git.setRemote({ url: 'git@github.com:j/n.git', exists: true });
    await git.setRemote({ url: 'git@github.com:j/n.git', exists: false });
    expect(invoke.mock.calls.map(([, args]) => (args as { args: string[] }).args)).toEqual([
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
      ['commit', '--quiet', '--no-verify', '-m', 'DFAI sync'],
      [
        '-c',
        'user.name=DFAI on Mac',
        '-c',
        'user.email=a@b',
        'commit',
        '--quiet',
        '--no-verify',
        '-m',
        'm',
      ],
      ['merge', '--no-edit', '--allow-unrelated-histories', 'refs/remotes/origin/main'],
      [
        '-c',
        'user.name=DFAI on Mac',
        '-c',
        'user.email=a@b',
        'merge',
        '--no-edit',
        '--allow-unrelated-histories',
        'refs/remotes/origin/main',
      ],
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'],
      ['checkout', '--theirs', '--', 'Ideas.md'],
      ['remote', 'set-url', 'origin', 'git@github.com:j/n.git'],
      ['remote', 'add', 'origin', 'git@github.com:j/n.git'],
    ]);
    expect(
      invoke.mock.calls.every(
        ([command, args]) => command === 'git_run' && (args as { vault: string }).vault === '/v',
      ),
    ).toBe(true);
  });

  it('hands the host what the sync saw of a file a checkout writes over (#246)', async () => {
    const git = tauriGit('/v');
    await git.checkout({ side: 'ours', path: 'Ideas.md', seen: 'c'.repeat(40) });
    await git.checkout({ side: 'theirs', path: 'New.md', seen: null });
    expect(invoke.mock.calls).toEqual([
      [
        'git_run',
        {
          vault: '/v',
          args: ['checkout', '--ours', '--', 'Ideas.md'],
          seen: { blob: 'c'.repeat(40) },
        },
      ],
      [
        'git_run',
        { vault: '/v', args: ['checkout', '--theirs', '--', 'New.md'], seen: { blob: null } },
      ],
    ]);
  });

  it('says the file changed when the host would not write over a newer one', async () => {
    invoke.mockRejectedValue('changed: Ideas.md changed since the sync looked at it');
    const checkout = tauriGit('/v').checkout({ side: 'ours', path: 'Ideas.md', seen: null });
    await expect(checkout).rejects.toBeInstanceOf(FileChangedError);
    await expect(checkout).rejects.toThrow('Ideas.md changed since the sync looked at it');
  });

  it('runs each step the settle and the case and size rules take as a shape the host holds (A29-01)', async () => {
    const oid = '0123456789abcdef0123456789abcdef01234567';
    const git = tauriGit('/v');
    await git.untrackedExact();
    await git.indexEntries();
    await git.move({ from: 'idea.md', to: 'idea (conflict from Laptop).md' });
    await git.tree({ kind: 'head' });
    await git.tree({ kind: 'remote', branch: 'main' });
    await git.tree({ kind: 'commit', oid });
    await git.mergeBase('main');
    await git.hashFile('Notes/Idea.md');
    await git.stageBlob({ mode: '100644', oid, path: 'Idea (conflict from Studio).md' });
    await git.writeFromIndex('Idea (conflict from Studio).md');
    await git.untrack('Attachments/talk.mov');
    await git.unstage('Data/dump.bin');
    await git.resetSoftTo('main');
    await git.largeUnpushed(99_614_720);
    await git.remoteHead();
    await git.renameBranch('master');
    await git.remoteSettingsExist('main');
    await git.remoteSettings('main');
    // The same shapes, word for word, as `ACCEPTED` in the host's tests.
    expect(invoke.mock.calls.map(([, args]) => (args as { args: string[] }).args)).toEqual([
      ['-c', 'core.ignoreCase=false', 'ls-files', '-z', '--others', '--exclude-standard'],
      ['ls-files', '-z', '--stage'],
      ['mv', '--', 'idea.md', 'idea (conflict from Laptop).md'],
      ['ls-tree', '-r', '-z', 'HEAD'],
      ['ls-tree', '-r', '-z', 'refs/remotes/origin/main'],
      ['ls-tree', '-r', '-z', oid],
      ['merge-base', 'HEAD', 'refs/remotes/origin/main'],
      ['hash-object', '--no-filters', '--', 'Notes/Idea.md'],
      ['update-index', '--add', '--cacheinfo', `100644,${oid},Idea (conflict from Studio).md`],
      ['checkout-index', '--', 'Idea (conflict from Studio).md'],
      ['rm', '--cached', '--quiet', '--', 'Attachments/talk.mov'],
      ['reset', '--quiet', '--', 'Data/dump.bin'],
      ['reset', '--quiet', '--soft', 'refs/remotes/origin/main'],
      [
        'rev-list',
        '--objects',
        '--filter=blob:limit=99614720',
        '--filter-print-omitted',
        'HEAD',
        '--not',
        '--remotes=origin',
      ],
      ['ls-remote', '--symref', 'origin', 'HEAD'],
      ['branch', '-m', 'master'],
      ['cat-file', '-e', 'refs/remotes/origin/main:.atlas/settings.md'],
      ['cat-file', 'blob', 'refs/remotes/origin/main:.atlas/settings.md'],
    ]);
  });

  it('reads and writes the sync’s own files through the host, naming its vault', async () => {
    invoke.mockResolvedValueOnce('{"version":1}');
    const files = tauriSyncFiles('/v');
    await expect(files.read('journal.json')).resolves.toBe('{"version":1}');
    await files.write('exclude', '/big.mov\n');
    await files.write('journal.json', null);
    expect(invoke.mock.calls).toEqual([
      ['git_sync_file_read', { vault: '/v', name: 'journal.json' }],
      ['git_sync_file_write', { vault: '/v', name: 'exclude', contents: '/big.mov\n' }],
      ['git_sync_file_write', { vault: '/v', name: 'journal.json', contents: null }],
    ]);
  });

  it('hands back what git printed, as it printed it', async () => {
    await expect(tauriGit('/v').head()).resolves.toEqual(OUTPUT);
  });

  it('creates a GitHub repository through gh, naming its vault', async () => {
    await tauriGit('/v').createGitHubRepository('notes');
    expect(invoke).toHaveBeenCalledWith('gh_repo_create', { vault: '/v', name: 'notes' });
  });

  it('says which program is missing when the host found none', async () => {
    invoke.mockRejectedValueOnce('not_found: no git in /opt/homebrew/bin');
    await expect(tauriGit('/v').fetch()).rejects.toEqual(new ProgramMissingError('git'));
    invoke.mockRejectedValueOnce('not_found: no gh');
    await expect(tauriGit('/v').createGitHubRepository('n')).rejects.toBeInstanceOf(
      ProgramMissingError,
    );
  });

  it('says in the host’s words that the person said no', async () => {
    invoke.mockRejectedValueOnce('declined: You cancelled connecting the vault to git@x:y.git.');
    await expect(tauriGit('/v').setRemote({ url: 'git@x:y.git', exists: false })).rejects.toThrow(
      /^You cancelled connecting the vault to git@x:y.git.$/,
    );
  });

  it('passes on any other refusal as an error', async () => {
    invoke.mockRejectedValueOnce('another vault was opened before this could be written');
    await expect(tauriGit('/v').push()).rejects.toThrow('another vault was opened');
  });
});

describe('tauriGitFolders and tauriMacName', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(OUTPUT);
  });

  it('asks about and clones into a folder outside any vault', async () => {
    await tauriGitFolders.topLevelOf('/Users/j');
    await tauriGitFolders.clone({ url: 'https://github.com/j/n', folder: '/Users/j', name: 'n' });
    expect(invoke.mock.calls).toEqual([
      ['git_run_in', { folder: '/Users/j', args: ['rev-parse', '--show-toplevel'] }],
      [
        'git_run_in',
        {
          folder: '/Users/j',
          args: ['clone', '--quiet', '--origin', 'origin', '--', 'https://github.com/j/n', 'n'],
        },
      ],
    ]);
  });

  it('asks a repository for its branches in the shape the host holds, and the host where a folder is on disk', async () => {
    await tauriGitFolders.branchesAt({ url: 'https://github.com/j/n', folder: '/Users/j' });
    invoke.mockResolvedValueOnce('/private/var/j');
    await expect(tauriGitFolders.onDisk('/var/j')).resolves.toBe('/private/var/j');
    expect(invoke.mock.calls).toEqual([
      [
        'git_run_in',
        { folder: '/Users/j', args: ['ls-remote', '--heads', '--', 'https://github.com/j/n'] },
      ],
      ['git_folder_on_disk', { folder: '/var/j' }],
    ]);
  });

  it('asks the host, not the webview, where a clone may go', async () => {
    invoke.mockResolvedValueOnce({ absolutePath: '/Users/j', name: 'j' });
    await expect(tauriGitFolders.pickCloneFolder()).resolves.toEqual({
      absolutePath: '/Users/j',
      name: 'j',
    });
    expect(invoke).toHaveBeenCalledWith('git_pick_clone_folder');
  });

  it('lists GitHub repositories through the host’s one read-only gh command', async () => {
    invoke.mockResolvedValueOnce({ code: 0, stdout: '[]', stderr: '' });
    await expect(tauriGitHub.listRepositories()).resolves.toEqual({
      code: 0,
      stdout: '[]',
      stderr: '',
    });
    expect(invoke).toHaveBeenCalledWith('gh_repo_list');
    invoke.mockRejectedValueOnce('not_found: no gh');
    await expect(tauriGitHub.listRepositories()).rejects.toEqual(new ProgramMissingError('gh'));
  });

  it('reads this Mac’s name from the host', async () => {
    invoke.mockResolvedValueOnce('Studio');
    await expect(tauriMacName.name()).resolves.toBe('Studio');
    expect(invoke).toHaveBeenCalledWith('this_mac_name');
  });
});
