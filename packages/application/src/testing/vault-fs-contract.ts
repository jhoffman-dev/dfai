import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import {
  EntryChangedError,
  HOST_CHANGED_ON_DISK,
  VaultAccessError,
  type HostVaultFsPort,
} from '../vault/ports.ts';

/**
 * What every vault the app writes through must do, as the desktop's host
 * does it (`apps/desktop/src-tauri/src/vault*.rs`): the web stub's session
 * vault runs it now, and the GitHub vault (#664) runs the same suite (#689).
 * A rule here is the host's; a change to one is a change to the host first.
 *
 * Names differ by more than case: a create or a move onto a name that only
 * differs in case from one there is refused, as the Mac's disk refuses it,
 * because a vault synced between a Mac and GitHub breaks on case-only siblings.
 */

export type VaultUnderTest = { readonly fs: HostVaultFsPort; readonly vault: string };

const p = createVaultPath;
const WALK = { skipDirectories: [] as string[], maxDepth: 10 };
const SEED: Readonly<Record<string, string>> = {
  'Welcome.md': '# Welcome\n',
  'Projects/Larkspur.md': '# Larkspur\n',
  'Projects/Old/Plan.md': '# Plan\n',
};
const bytes = (...values: number[]) => new Uint8Array(values);

export function vaultFsContract(
  name: string,
  make: (seed: Readonly<Record<string, string>>) => VaultUnderTest,
): void {
  const seeded = () => make(SEED);
  describe(`${name}: the vault contract (#689)`, () => {
    savesContract(seeded);
    createsContract(seeded);
    bytesContract(seeded);
    movesContract(seeded);
    pathsContract(seeded);
    walksContract(seeded);
  });
}

type Seeded = () => VaultUnderTest;

function savesContract(seeded: Seeded) {
  it('reads back a note it saved', async () => {
    const { fs, vault } = seeded();
    const { modified } = await fs.readTextFile(p('Welcome.md'));
    await fs.writeTextFile({
      vault,
      path: p('Welcome.md'),
      contents: 'new',
      expectedModified: modified,
    });
    expect((await fs.readTextFile(p('Welcome.md'))).text).toBe('new');
  });

  it('refuses a save over a note changed since it was read, by time or by text', async () => {
    const { fs, vault } = seeded();
    const { modified, text } = await fs.readTextFile(p('Welcome.md'));
    await fs.writeTextFile({
      vault,
      path: p('Welcome.md'),
      contents: 'first',
      expectedModified: modified,
    });
    const at = { vault, path: p('Welcome.md'), contents: 'second' };
    await expect(fs.writeTextFile({ ...at, expectedModified: modified })).rejects.toThrow(
      HOST_CHANGED_ON_DISK,
    );
    await expect(
      fs.writeTextFile({ ...at, expectedModified: null, expectedText: text }),
    ).rejects.toThrow(HOST_CHANGED_ON_DISK);
    expect((await fs.readTextFile(p('Welcome.md'))).text).toBe('first');
  });

  it('never brings back a note by saving it, and never saves over a folder', async () => {
    const { fs, vault } = seeded();
    await fs.trashEntry({ vault, path: p('Welcome.md') });
    const save = { vault, contents: 'back', expectedModified: null };
    await expect(fs.writeTextFile({ ...save, path: p('Welcome.md') })).rejects.toThrow(
      'no such entry',
    );
    await expect(fs.readTextFile(p('Welcome.md'))).rejects.toThrow(VaultAccessError);
    await expect(fs.writeTextFile({ ...save, path: p('Projects') })).rejects.toThrow(
      'that is a directory',
    );
  });

  it('trashes a file, but not one changed since it was read', async () => {
    const { fs, vault } = seeded();
    const read = await fs.readTextFile(p('Welcome.md'));
    await fs.writeTextFile({
      vault,
      path: p('Welcome.md'),
      contents: 'edited',
      expectedModified: null,
    });
    const unchanged = [{ path: p('Welcome.md'), modified: read.modified, text: read.text }];
    await expect(fs.trashEntry({ vault, path: p('Welcome.md'), unchanged })).rejects.toThrow(
      EntryChangedError,
    );
    await fs.trashEntry({ vault, path: p('Welcome.md') });
    await expect(fs.readTextFile(p('Welcome.md'))).rejects.toThrow('no such entry');
  });
}

function createsContract(seeded: Seeded) {
  it('creates a note only where none is, and only in a folder that is there', async () => {
    const { fs, vault } = seeded();
    await fs.createNote({ vault, path: p('Ideas.md'), contents: 'idea' });
    await expect(fs.createNote({ vault, path: p('Ideas.md'), contents: 'again' })).rejects.toThrow(
      'already exists',
    );
    await expect(
      fs.createNote({ vault, path: p('Missing/Note.md'), contents: 'x' }),
    ).rejects.toThrow('that folder does not exist');
    await expect(fs.createFolder({ vault, path: p('Nowhere/Inner') })).rejects.toThrow(
      'that folder does not exist',
    );
    await fs.createFolder({ vault, path: p('Archive') });
    expect(await fs.listDirectory(p('Archive'))).toEqual([]);
  });

  it('refuses a name that only differs in case from one there', async () => {
    const { fs, vault } = seeded();
    await expect(fs.createNote({ vault, path: p('welcome.md'), contents: 'x' })).rejects.toThrow(
      'already exists',
    );
    await expect(fs.createFolder({ vault, path: p('projects') })).rejects.toThrow(VaultAccessError);
    await fs.createNote({ vault, path: p('b.md'), contents: 'b' });
    await expect(fs.moveEntry({ vault, from: p('Welcome.md'), to: p('B.md') })).rejects.toThrow(
      'already there',
    );
  });

  it('refuses every write meant for another vault', async () => {
    const { fs } = seeded();
    const vault = '/another';
    await expect(fs.createNote({ vault, path: p('Stray.md'), contents: 'x' })).rejects.toThrow(
      'not the open vault',
    );
    await expect(
      fs.writeTextFile({ vault, path: p('Welcome.md'), contents: 'x', expectedModified: null }),
    ).rejects.toThrow('not the open vault');
    await expect(fs.trashEntry({ vault, path: p('Welcome.md') })).rejects.toThrow(
      'not the open vault',
    );
  });
}

function bytesContract(seeded: Seeded) {
  it('keeps bytes written in chunks, and refuses a chunk out of order or over a file', async () => {
    const { fs, vault } = seeded();
    const path = p('pasted.png');
    expect(await fs.writeBinaryFile({ vault, path, bytes: bytes(1, 2), offset: 0 })).toBe(2);
    expect(await fs.writeBinaryFile({ vault, path, bytes: bytes(3), offset: 2 })).toBe(3);
    await expect(fs.writeBinaryFile({ vault, path, bytes: bytes(9), offset: 1 })).rejects.toThrow(
      VaultAccessError,
    );
    await expect(fs.writeBinaryFile({ vault, path, bytes: bytes(9), offset: 0 })).rejects.toThrow(
      'already exists',
    );
    expect([...new Uint8Array(await fs.readBinaryFile(path))]).toEqual([1, 2, 3]);
  });

  it('replaces whole only from 0, never a folder, and never past 32 MB', async () => {
    const { fs, vault } = seeded();
    const path = p('t.png');
    await fs.writeBinaryFile({ vault, path, bytes: bytes(1, 2), offset: 0 });
    const replace = { vault, replace: true };
    await expect(
      fs.writeBinaryFile({ ...replace, path, bytes: bytes(9), offset: 2 }),
    ).rejects.toThrow('from offset 0');
    await expect(
      fs.writeBinaryFile({ ...replace, path: p('Projects'), bytes: bytes(1), offset: 0 }),
    ).rejects.toThrow('that is a directory');
    await fs.writeBinaryFile({ ...replace, path, bytes: bytes(7), offset: 0 });
    expect([...new Uint8Array(await fs.readBinaryFile(path))]).toEqual([7]);
    const big = new Uint8Array(32 * 1024 * 1024 + 1);
    await expect(
      fs.writeBinaryFile({ vault, path: p('big.bin'), bytes: big, offset: 0 }),
    ).rejects.toThrow('32 MB');
  });

  it('writes bytes only into a folder that is there', async () => {
    const { fs, vault } = seeded();
    await expect(
      fs.writeBinaryFile({ vault, path: p('Nope/a.bin'), bytes: bytes(1), offset: 0 }),
    ).rejects.toThrow('that folder does not exist');
  });

  it('reads a note that arrived as bytes as text, when it is UTF-8, and refuses it when not', async () => {
    const { fs, vault } = seeded();
    const text = new TextEncoder().encode('# Imported ✓\n');
    await fs.writeBinaryFile({ vault, path: p('Imported.md'), bytes: text, offset: 0 });
    expect((await fs.readTextFile(p('Imported.md'))).text).toBe('# Imported ✓\n');
    expect((await fs.readNotes(['Imported.md'])).map((note) => note.text)).toEqual([
      '# Imported ✓\n',
    ]);
    await fs.writeBinaryFile({ vault, path: p('Broken.md'), bytes: bytes(0xff, 0xfe), offset: 0 });
    await expect(fs.readTextFile(p('Broken.md'))).rejects.toThrow(VaultAccessError);
  });
}

function movesContract(seeded: Seeded) {
  it('moves a folder with everything in it, and refuses to land on something there', async () => {
    const { fs, vault } = seeded();
    await fs.moveEntry({ vault, from: p('Projects'), to: p('Areas') });
    expect((await fs.readTextFile(p('Areas/Old/Plan.md'))).text).toBe('# Plan\n');
    await expect(fs.readTextFile(p('Projects/Larkspur.md'))).rejects.toThrow('no such entry');
    await expect(fs.moveEntry({ vault, from: p('Welcome.md'), to: p('Areas') })).rejects.toThrow(
      'already there',
    );
  });

  it('refuses a folder moved into itself, and leaves the tree as it was', async () => {
    const { fs, vault } = seeded();
    for (const to of ['Projects/Inner', 'Projects/Old/Projects']) {
      await expect(fs.moveEntry({ vault, from: p('Projects'), to: p(to) })).rejects.toThrow(
        'into itself',
      );
    }
    const listed = (await fs.listNotes(WALK)).map((note) => note.path).sort();
    expect(listed).toEqual(['Projects/Larkspur.md', 'Projects/Old/Plan.md', 'Welcome.md']);
  });

  it('takes a move onto its own path as nothing to do, and one in another case as its rename', async () => {
    const { fs, vault } = seeded();
    await expect(
      fs.moveEntry({ vault, from: p('Welcome.md'), to: p('Welcome.md') }),
    ).resolves.toBeUndefined();
    await fs.moveEntry({ vault, from: p('Welcome.md'), to: p('welcome.md') });
    expect((await fs.readTextFile(p('welcome.md'))).text).toBe('# Welcome\n');
  });
}

function pathsContract(seeded: Seeded) {
  it('refuses anything in git’s own folder, in any case, read or write', async () => {
    const { fs, vault } = seeded();
    await expect(fs.createFolder({ vault, path: p('.git') })).rejects.toThrow('git');
    await expect(
      fs.createNote({ vault, path: p('.GIT/config.md'), contents: 'x' }),
    ).rejects.toThrow('git');
    await expect(fs.readTextFile(p('Projects/.Git/HEAD'))).rejects.toThrow('git');
    await expect(fs.listDirectory(p('.git'))).rejects.toThrow('git');
  });

  it('refuses a path with a . or .. segment, whatever the type said', async () => {
    const { fs, vault } = seeded();
    for (const path of ['../escaped.md', 'Projects/../Welcome.md', './Welcome.md']) {
      await expect(
        fs.createNote({ vault, path: path as VaultPath, contents: 'x' }),
      ).rejects.toThrow(VaultAccessError);
      await expect(fs.readTextFile(path as VaultPath)).rejects.toThrow(VaultAccessError);
    }
  });
}

function walksContract(seeded: Seeded) {
  it('lists a folder by name, folders and files with their kind', async () => {
    const { fs } = seeded();
    const names = (await fs.listDirectory(p(''))).map((entry) => `${entry.kind}:${entry.name}`);
    expect(names).toEqual(['directory:Projects', 'file:Welcome.md']);
  });

  it('skips an entry by its own name at any level, file or folder, never by a path', async () => {
    const { fs, vault } = seeded();
    await fs.createNote({ vault, path: p('Projects/Skip.md'), contents: 'x' });
    const listed = async (skipDirectories: string[]) =>
      (await fs.listNotes({ skipDirectories, maxDepth: 10 })).map((note) => note.path).sort();
    expect(await listed(['Old'])).toEqual([
      'Projects/Larkspur.md',
      'Projects/Skip.md',
      'Welcome.md',
    ]);
    expect(await listed(['Projects/Old'])).toContain('Projects/Old/Plan.md');
    expect(await listed(['Skip.md'])).not.toContain('Projects/Skip.md');
  });

  it('walks no deeper than it is told, and reads many notes in one call', async () => {
    const { fs } = seeded();
    const shallow = (await fs.listNotes({ skipDirectories: [], maxDepth: 1 })).map(
      (note) => note.path,
    );
    expect(shallow.sort()).toEqual(['Projects/Larkspur.md', 'Welcome.md']);
    expect((await fs.readNotes(['Welcome.md', 'Gone.md'])).map((note) => note.text)).toEqual([
      '# Welcome\n',
    ]);
  });

  it('lists files by extension in any case, sorted', async () => {
    const { fs, vault } = seeded();
    for (const path of ['b.PDF', 'Projects/a.pdf', 'a.pdf']) {
      await fs.writeBinaryFile({ vault, path: p(path), bytes: bytes(1), offset: 0 });
    }
    expect(await fs.listFiles({ extension: 'pdf', ...WALK })).toEqual([
      'Projects/a.pdf',
      'a.pdf',
      'b.PDF',
    ]);
  });
}
