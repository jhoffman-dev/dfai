import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { EntryChangedError, HOST_CHANGED_ON_DISK, VaultAccessError } from '@dfai/application';
import { sessionVaultFs } from './session-vault.ts';

const vault = '/sample';
const p = createVaultPath;
const WALK = { skipDirectories: ['.git'], maxDepth: 10 };

const seeded = () =>
  sessionVaultFs({
    'Welcome.md': '# Welcome\n',
    'Projects/Larkspur.md': '# Larkspur\n',
    '.git/HEAD.md': 'not a note',
  });

describe('the web stub’s session vault (#656)', () => {
  it('reads back a note it saved, and lists what is in a folder', async () => {
    const fs = seeded();
    const { modified } = await fs.readTextFile(p('Welcome.md'));
    await fs.writeTextFile({
      vault,
      path: p('Welcome.md'),
      contents: 'new',
      expectedModified: modified,
    });
    expect((await fs.readTextFile(p('Welcome.md'))).text).toBe('new');
    const names = (await fs.listDirectory(p(''))).map((entry) => `${entry.kind}:${entry.name}`);
    expect(names.sort()).toEqual(['directory:.git', 'directory:Projects', 'file:Welcome.md']);
  });

  it('refuses a save over a note changed since it was read, as the host does', async () => {
    const fs = seeded();
    const { modified, text } = await fs.readTextFile(p('Welcome.md'));
    await fs.writeTextFile({
      vault,
      path: p('Welcome.md'),
      contents: 'first',
      expectedModified: modified,
    });
    const stale = fs.writeTextFile({
      vault,
      path: p('Welcome.md'),
      contents: 'second',
      expectedModified: modified,
    });
    await expect(stale).rejects.toThrow(HOST_CHANGED_ON_DISK);
    const byText = fs.writeTextFile({
      vault,
      path: p('Welcome.md'),
      contents: 'third',
      expectedModified: null,
      expectedText: text,
    });
    await expect(byText).rejects.toThrow(HOST_CHANGED_ON_DISK);
    expect((await fs.readTextFile(p('Welcome.md'))).text).toBe('first');
  });

  it('lists notes outside the folders it is told to skip, and reads them in one call', async () => {
    const fs = seeded();
    const listed = (await fs.listNotes(WALK)).map((note) => note.path);
    expect(listed.sort()).toEqual(['Projects/Larkspur.md', 'Welcome.md']);
    const read = await fs.readNotes(['Welcome.md', 'Gone.md']);
    expect(read.map((note) => note.text)).toEqual(['# Welcome\n']);
  });

  it('creates a note only where none is, and a folder only under one', async () => {
    const fs = seeded();
    await fs.createNote({ vault, path: p('Ideas.md'), contents: 'idea' });
    await expect(fs.createNote({ vault, path: p('Ideas.md'), contents: 'again' })).rejects.toThrow(
      VaultAccessError,
    );
    await expect(fs.createFolder({ vault, path: p('Nowhere/Inner') })).rejects.toThrow(
      'no such folder',
    );
    await fs.createFolder({ vault, path: p('Archive') });
    expect(await fs.listDirectory(p('Archive'))).toEqual([]);
  });

  it('keeps bytes written in chunks, refuses a chunk out of order, and replaces whole on asking', async () => {
    const fs = seeded();
    const path = p('pasted.png');
    expect(
      await fs.writeBinaryFile({ vault, path, bytes: new Uint8Array([1, 2]), offset: 0 }),
    ).toBe(2);
    expect(await fs.writeBinaryFile({ vault, path, bytes: new Uint8Array([3]), offset: 2 })).toBe(
      3,
    );
    await expect(
      fs.writeBinaryFile({ vault, path, bytes: new Uint8Array([9]), offset: 1 }),
    ).rejects.toThrow(VaultAccessError);
    await expect(
      fs.writeBinaryFile({ vault, path, bytes: new Uint8Array([9]), offset: 0 }),
    ).rejects.toThrow('already exists');
    expect([...new Uint8Array(await fs.readBinaryFile(path))]).toEqual([1, 2, 3]);
    await fs.writeBinaryFile({ vault, path, bytes: new Uint8Array([7]), offset: 0, replace: true });
    expect([...new Uint8Array(await fs.readBinaryFile(path))]).toEqual([7]);
    expect(await fs.listFiles({ extension: 'PNG', ...WALK })).toEqual([path]);
    await expect(fs.readTextFile(path)).rejects.toThrow('not a text file');
  });

  it('moves a folder with everything in it, and refuses to land on something there', async () => {
    const fs = seeded();
    await fs.moveEntry({ vault, from: p('Projects'), to: p('Areas') });
    expect((await fs.readTextFile(p('Areas/Larkspur.md'))).text).toBe('# Larkspur\n');
    await expect(fs.readTextFile(p('Projects/Larkspur.md'))).rejects.toThrow('no such entry');
    await expect(fs.moveEntry({ vault, from: p('Welcome.md'), to: p('Areas') })).rejects.toThrow(
      'already there',
    );
  });

  it('trashes a file, but not one changed since it was read', async () => {
    const fs = seeded();
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
});
