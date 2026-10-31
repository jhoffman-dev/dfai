import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EntryChangedError, MoveRefusedError, VaultAccessError } from '@dfai/application';
import {
  InvalidVaultPathError,
  VAULT_ROOT,
  createVaultPath,
  deleteThroughLinkRefusal,
  moveRepointsLinkRefusal,
  moveThroughLinkRefusal,
} from '@dfai/domain';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { tauriVaultFs } = await import('./tauri-vault-fs.ts');

describe('tauriVaultFs.listDirectory', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('asks the host for the requested directory', async () => {
    invoke.mockResolvedValue([]);
    await tauriVaultFs.listDirectory(createVaultPath('Notes'));
    expect(invoke).toHaveBeenCalledWith('list_directory', { path: 'Notes' });
  });

  it('turns raw host entries into domain entries', async () => {
    invoke.mockResolvedValue([
      { name: 'Notes', path: 'Notes', kind: 'directory' },
      { name: 'a.md', path: 'a.md', kind: 'file' },
    ]);
    const entries = await tauriVaultFs.listDirectory(VAULT_ROOT);
    expect(entries).toEqual([
      { kind: 'directory', name: 'Notes', path: 'Notes' },
      { kind: 'file', name: 'a.md', path: 'a.md' },
    ]);
  });

  it("keeps a file's modified time and size, so an image too big is never read", async () => {
    invoke.mockResolvedValue([
      { name: 'Notes', path: 'Notes', kind: 'directory', modified: 5, size: 0 },
      { name: 'a.png', path: 'a.png', kind: 'file', modified: 1_700_000, size: 3 },
    ]);
    const entries = await tauriVaultFs.listDirectory(VAULT_ROOT);
    expect(entries).toEqual([
      { kind: 'directory', name: 'Notes', path: 'Notes' },
      { kind: 'file', name: 'a.png', path: 'a.png', modified: 1_700_000, size: 3 },
    ]);
  });

  it('keeps which entries are links, and nothing for one that is not (#169)', async () => {
    invoke.mockResolvedValue([
      { name: 'alias', path: 'alias', kind: 'directory', link: true },
      { name: 'a.md', path: 'a.md', kind: 'file', link: true },
      { name: 'b.md', path: 'b.md', kind: 'file', link: false },
    ]);
    const entries = await tauriVaultFs.listDirectory(VAULT_ROOT);
    expect(entries).toEqual([
      { kind: 'directory', name: 'alias', path: 'alias', link: true },
      { kind: 'file', name: 'a.md', path: 'a.md', link: true },
      { kind: 'file', name: 'b.md', path: 'b.md' },
    ]);
  });

  it('treats an unrecognised kind as a file rather than trusting the host', async () => {
    invoke.mockResolvedValue([{ name: 'odd', path: 'odd', kind: 'socket' }]);
    const [entry] = await tauriVaultFs.listDirectory(VAULT_ROOT);
    expect(entry?.kind).toBe('file');
  });

  it('refuses a host path that would escape the vault', async () => {
    invoke.mockResolvedValue([{ name: 'evil', path: '../evil', kind: 'file' }]);
    await expect(tauriVaultFs.listDirectory(VAULT_ROOT)).rejects.toThrow(InvalidVaultPathError);
  });

  it('propagates a host error', async () => {
    invoke.mockImplementation(() => Promise.reject(new VaultAccessError('no vault is open')));
    await expect(tauriVaultFs.listDirectory(VAULT_ROOT)).rejects.toThrow('no vault is open');
  });
});

describe('tauriVaultFs.listFiles', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('asks the host for one walk, with the extension, the folders to skip and the depth', async () => {
    invoke.mockResolvedValue(['Library/a.pdf', '.trash/b.pdf']);
    await expect(
      tauriVaultFs.listFiles({ extension: 'pdf', skipDirectories: ['.git'], maxDepth: 7 }),
    ).resolves.toEqual(['Library/a.pdf', '.trash/b.pdf']);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('list_vault_files', {
      extension: 'pdf',
      skipDirectories: ['.git'],
      maxDepth: 7,
    });
  });

  it('propagates a vault that cannot be listed', async () => {
    invoke.mockImplementation(() =>
      Promise.reject(new VaultAccessError('the vault could not be listed')),
    );
    await expect(
      tauriVaultFs.listFiles({ extension: 'pdf', skipDirectories: [], maxDepth: 32 }),
    ).rejects.toThrow('the vault could not be listed');
  });
});

describe('tauriVaultFs.listNotes', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('passes the folders it was told to skip, and how deep to go, on to the host', async () => {
    invoke.mockResolvedValue([]);
    await tauriVaultFs.listNotes({ skipDirectories: ['.git', 'node_modules'], maxDepth: 7 });
    expect(invoke).toHaveBeenCalledWith('list_notes', {
      skipDirectories: ['.git', 'node_modules'],
      maxDepth: 7,
    });
  });

  it('asks for the whole tree when nothing is to be skipped', async () => {
    invoke.mockResolvedValue([]);
    await tauriVaultFs.listNotes({ skipDirectories: [], maxDepth: 32 });
    expect(invoke).toHaveBeenCalledWith('list_notes', { skipDirectories: [], maxDepth: 32 });
  });

  it('keeps the file facts the index needs, and decides nothing itself', async () => {
    // Including the dotted paths the host now reports: filtering them is the
    // frontend's job and happens a layer up, not here.
    invoke.mockResolvedValue([
      { name: 'a.md', path: 'a.md', kind: 'file', modified: 12, size: 34 },
      { name: 'task.md', path: '.atlas/types/task.md', kind: 'file', modified: 5, size: 6 },
    ]);
    await expect(tauriVaultFs.listNotes({ skipDirectories: [], maxDepth: 32 })).resolves.toEqual([
      { name: 'a.md', path: 'a.md', modified: 12, size: 34 },
      { name: 'task.md', path: '.atlas/types/task.md', modified: 5, size: 6 },
    ]);
  });

  it('refuses a host path that would escape the vault', async () => {
    invoke.mockResolvedValue([
      { name: 'evil.md', path: '../evil.md', kind: 'file', modified: 1, size: 1 },
    ]);
    await expect(tauriVaultFs.listNotes({ skipDirectories: [], maxDepth: 32 })).rejects.toThrow(
      InvalidVaultPathError,
    );
  });

  it('propagates a host error', async () => {
    invoke.mockImplementation(() => Promise.reject(new VaultAccessError('no vault is open')));
    await expect(tauriVaultFs.listNotes({ skipDirectories: [], maxDepth: 32 })).rejects.toThrow(
      'no vault is open',
    );
  });
});

describe('tauriVaultFs.readTextFile', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('returns the text the host read', async () => {
    invoke.mockResolvedValue('# Today\n');
    await expect(tauriVaultFs.readTextFile(createVaultPath('a.md'))).resolves.toBe('# Today\n');
    expect(invoke).toHaveBeenCalledWith('read_text_file', { path: 'a.md' });
  });

  it('propagates a host refusal, such as a file that is not text', async () => {
    invoke.mockImplementation(() => Promise.reject(new VaultAccessError('not a text file')));
    await expect(tauriVaultFs.readTextFile(createVaultPath('a.png'))).rejects.toThrow(
      'not a text file',
    );
  });
});

describe('tauriVaultFs writes', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(0);
  });

  const notes = createVaultPath('notes.md');

  it('passes the vault a save was meant for on to the host, to compare', async () => {
    await tauriVaultFs.writeTextFile({
      path: notes,
      contents: 'x',
      expectedModified: 7,
      vault: '/vaults/a',
    });
    expect(invoke).toHaveBeenCalledWith('write_text_file', {
      path: 'notes.md',
      contents: 'x',
      expectedModified: 7,
      vault: '/vaults/a',
    });
    expect(invoke.mock.calls[0]?.[1]).not.toHaveProperty('expectedDigest');
  });

  // The digest the Rust host compares (`vault.rs`, `coarse_clock_tests`):
  // SHA-256 of the UTF-8 bytes, in lowercase hex. The text crosses as its
  // digest, not a second copy of the note (#245).
  it('sends the text a save was read as for the host to compare, as its SHA-256', async () => {
    await tauriVaultFs.writeTextFile({
      path: notes,
      contents: 'x',
      expectedModified: 7,
      expectedText: 'abc',
      vault: '/vaults/a',
    });
    expect(invoke).toHaveBeenCalledWith('write_text_file', {
      path: 'notes.md',
      contents: 'x',
      expectedModified: 7,
      expectedDigest: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      vault: '/vaults/a',
    });
  });

  it('digests a byte-order mark and Windows line ends as the bytes they are', async () => {
    await tauriVaultFs.writeTextFile({
      path: notes,
      contents: 'x',
      expectedModified: null,
      expectedText: '\uFEFF# T\r\nx\r\n',
      vault: '/vaults/a',
    });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      expectedDigest: '305c72150069909fa225462ab528cd57557fee2a22b08a76dda0180ad541e5d3',
    });
  });

  it('digests the bytes of text beyond ASCII, as the host reads them', async () => {
    await tauriVaultFs.writeTextFile({
      path: notes,
      contents: 'x',
      expectedModified: null,
      expectedText: 'café\n',
      vault: '/vaults/a',
    });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      expectedDigest: '7b49b9e063bd91a4f9252b413261f5557b9c570aa61516989499f64a62dbcdd6',
    });
  });

  it('passes the vault on for a create, a move, a new folder and a delete too', async () => {
    await tauriVaultFs.createNote({ path: notes, contents: '', vault: '/vaults/a' });
    await tauriVaultFs.moveEntry({ from: notes, to: createVaultPath('b.md'), vault: '/vaults/a' });
    await tauriVaultFs.createFolder({ path: createVaultPath('Projects'), vault: '/vaults/a' });
    await tauriVaultFs.trashEntry({ path: notes, vault: '/vaults/a' });
    expect(invoke).toHaveBeenCalledWith('create_note', {
      path: 'notes.md',
      contents: '',
      vault: '/vaults/a',
    });
    expect(invoke).toHaveBeenCalledWith('move_entry', {
      from: 'notes.md',
      to: 'b.md',
      vault: '/vaults/a',
    });
    expect(invoke).toHaveBeenCalledWith('create_folder', { path: 'Projects', vault: '/vaults/a' });
    expect(invoke).toHaveBeenCalledWith('trash_entry', { path: 'notes.md', vault: '/vaults/a' });
  });

  it('hands back the time the host reports for a new note, as a save does (#258)', async () => {
    invoke.mockResolvedValue(1_760_000_000_123);
    await expect(
      tauriVaultFs.createNote({ path: notes, contents: '# New\n', vault: '/vaults/a' }),
    ).resolves.toBe(1_760_000_000_123);
  });

  it('surfaces a refused create as an error, never as a time', async () => {
    invoke.mockImplementation(() => Promise.reject('a note with that name already exists'));
    await expect(
      tauriVaultFs.createNote({ path: notes, contents: '', vault: '/vaults/a' }),
    ).rejects.toThrow('already exists');
  });

  it('asks the host to trash only while each file named is as it was read, its text as a digest (#235)', async () => {
    await tauriVaultFs.trashEntry({
      path: notes,
      vault: '/vaults/a',
      unchanged: [
        { path: notes, modified: 7, text: 'abc' },
        { path: createVaultPath('.atlas/settings.md'), modified: 9, text: '' },
      ],
    });
    expect(invoke).toHaveBeenCalledWith('trash_entry', {
      path: 'notes.md',
      vault: '/vaults/a',
      unchanged: [
        {
          path: 'notes.md',
          modified: 7,
          digest: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        },
        {
          path: '.atlas/settings.md',
          modified: 9,
          digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      ],
    });
  });

  it('surfaces the host finding a file changed before the Trash as EntryChangedError (#235)', async () => {
    invoke.mockImplementation(() =>
      Promise.reject('a file changed on disk since it was read, so nothing was moved to the Trash'),
    );
    await expect(
      tauriVaultFs.trashEntry({
        path: notes,
        vault: '/a',
        unchanged: [{ path: notes, modified: 7, text: 'abc' }],
      }),
    ).rejects.toThrow(EntryChangedError);
  });

  it('words the host refusing a move through a link as the app does (#680)', async () => {
    invoke.mockImplementation(() => Promise.reject('path goes through a link: Work/Alias'));
    const moving = tauriVaultFs.moveEntry({ from: notes, to: notes, vault: '/a' });

    await expect(moving).rejects.toThrow(
      new MoveRefusedError(moveThroughLinkRefusal(createVaultPath('Work/Alias'))),
    );
  });

  it('words the host refusing a move that re-points a link as the app does (#680)', async () => {
    invoke.mockImplementation(() =>
      Promise.reject('moving it would point a link elsewhere: Work/Projects/shelf'),
    );
    const moving = tauriVaultFs.moveEntry({ from: notes, to: notes, vault: '/a' });

    await expect(moving).rejects.toThrow(
      new MoveRefusedError(moveRepointsLinkRefusal(createVaultPath('Work/Projects/shelf'))),
    );
  });

  it('passes any other refused move through as the host said it', async () => {
    invoke.mockImplementation(() => Promise.reject('something with that name is already there'));
    const moving = tauriVaultFs.moveEntry({ from: notes, to: notes, vault: '/a' });

    await expect(moving).rejects.toThrow(
      new VaultAccessError('something with that name is already there'),
    );
  });

  it('words the host refusing a trash through a link as the app does (#685)', async () => {
    invoke.mockImplementation(() => Promise.reject('path goes through a link: Work/Alias'));
    const trashing = tauriVaultFs.trashEntry({ path: notes, vault: '/a' });

    await expect(trashing).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof VaultAccessError &&
        !(error instanceof EntryChangedError) &&
        error.message === deleteThroughLinkRefusal(createVaultPath('Work/Alias')),
    );
  });

  it('leaves a trash refused through a link no vault path can name as the host said it', async () => {
    const message = 'path goes through a link: Work/a\\b';
    invoke.mockImplementation(() => Promise.reject(message));
    const trashing = tauriVaultFs.trashEntry({ path: notes, vault: '/a' });

    await expect(trashing).rejects.toSatisfy(
      (error: unknown) => error instanceof VaultAccessError && error.message === message,
    );
  });

  it('surfaces a refused delete as an error, never as success', async () => {
    invoke.mockImplementation(() => Promise.reject('cannot move to the Trash: denied'));
    await expect(tauriVaultFs.trashEntry({ path: notes, vault: '/a' })).rejects.toThrow(
      'cannot move to the Trash',
    );
  });

  it('surfaces the refusal of a write meant for a vault that is no longer open', async () => {
    invoke.mockImplementation(() =>
      Promise.reject('another vault was opened before this could be written'),
    );
    await expect(
      tauriVaultFs.writeTextFile({ path: notes, contents: 'x', expectedModified: 7, vault: '/a' }),
    ).rejects.toThrow(VaultAccessError);
  });
});

describe('tauriVaultFs.writeBinaryFile', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('sends the bytes as the raw body and what they are for as encoded headers', async () => {
    invoke.mockResolvedValue(3);
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(
      tauriVaultFs.writeBinaryFile({
        path: createVaultPath('artifacts/café deck/index.html'),
        bytes,
        offset: 0,
        vault: '/Users/j/Vault ü',
      }),
    ).resolves.toBe(3);
    expect(invoke).toHaveBeenCalledWith('write_binary_file', bytes, {
      headers: {
        'atlas-path': 'artifacts%2Fcaf%C3%A9%20deck%2Findex.html',
        'atlas-offset': '0',
        'atlas-vault': '%2FUsers%2Fj%2FVault%20%C3%BC',
      },
    });
  });

  it('asks for a whole-file replace only when told to', async () => {
    invoke.mockResolvedValue(1);
    const bytes = new Uint8Array([9]);
    await tauriVaultFs.writeBinaryFile({
      path: createVaultPath('a/atlas-thumbnail.png'),
      bytes,
      offset: 0,
      replace: true,
      vault: '/a',
    });
    expect(invoke).toHaveBeenCalledWith('write_binary_file', bytes, {
      headers: {
        'atlas-path': 'a%2Fatlas-thumbnail.png',
        'atlas-offset': '0',
        'atlas-replace': '1',
        'atlas-vault': '%2Fa',
      },
    });
  });

  it('always names the vault, and reports a refusal as a VaultAccessError (R14-04)', async () => {
    invoke.mockImplementation(() =>
      Promise.reject('the file is not the length the write expected'),
    );
    await expect(
      tauriVaultFs.writeBinaryFile({
        path: createVaultPath('a/b.png'),
        bytes: new Uint8Array(1),
        offset: 5,
        vault: '/a',
      }),
    ).rejects.toThrow(VaultAccessError);
    expect(invoke.mock.calls[0]?.[2]).toEqual({
      headers: { 'atlas-path': 'a%2Fb.png', 'atlas-offset': '5', 'atlas-vault': '%2Fa' },
    });
  });
});
