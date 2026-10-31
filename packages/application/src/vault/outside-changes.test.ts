import { describe, expect, it } from 'vitest';
import { createVaultPath, parentVaultPath, vaultPathName, type VaultEntry } from '@dfai/domain';
import { fakeVaultFs } from '../testing/fake-ports.ts';
import { createOwnWrites, OWN_WRITE_KEPT_MS } from './own-writes.ts';
import { awaitsOwnRefresh, outsideChanges } from './outside-changes.ts';
import { recordingOwnWrites } from './recording-own-writes.ts';
import type { VaultFsPort } from './ports.ts';

const VAULT = '/vaults/larkspur';
const OTHER_VAULT = '/vaults/quill';
const path = createVaultPath;

type OnDisk = { readonly text: string; readonly modified: number } | 'folder';

/**
 * A vault on a disk, written to by the app (through `fs`) and by another
 * program (`outside`). The disk's clock is `mtime`, which a test holds still
 * to stand for a same-millisecond write or a coarse-clock disk.
 */
function aVault() {
  const files = new Map<string, OnDisk>();
  /** Every folder that has held anything, until another program takes it away: the disk keeps an emptied folder. */
  const folders = new Set<string>();
  const put = (at: string, file: OnDisk) => {
    files.set(at, file);
    for (let slash = at.indexOf('/'); slash > 0; slash = at.indexOf('/', slash + 1)) {
      folders.add(at.slice(0, slash));
    }
    if (file === 'folder') folders.add(at);
  };
  const disk = {
    mtime: 1_000,
    reads: 0,
    failReads: false,
    failListings: false,
    readPaths: [] as string[],
  };
  let wallClock = 50_000;
  const host: VaultFsPort = fakeVaultFs({
    readNotes: async (paths) => {
      disk.reads += 1;
      disk.readPaths = [...paths];
      if (disk.failReads) throw new Error('the host is busy');
      return paths.flatMap((each) => {
        const file = files.get(each);
        if (file === undefined || file === 'folder') return [];
        return [{ path: each, text: file.text, modified: file.modified, size: file.text.length }];
      });
    },
    listDirectory: async (folder) => {
      disk.reads += 1;
      if (disk.failReads || disk.failListings) throw new Error('the host is busy');
      // Listing a folder that is not there fails, as the host's does.
      if (folder !== '' && !folders.has(folder)) throw new Error('no such folder');
      return [...files]
        .filter(([each]) => parentVaultPath(path(each)) === folder)
        .map(([each, file]): VaultEntry => ({
          kind: file === 'folder' ? 'directory' : 'file',
          name: vaultPathName(path(each)),
          path: path(each),
        }));
    },
    writeTextFile: async ({ path: at, contents }) => {
      put(at, { text: contents, modified: disk.mtime });
      return disk.mtime;
    },
    createNote: async ({ path: at, contents }) => {
      put(at, { text: contents, modified: disk.mtime });
      return disk.mtime;
    },
    createFolder: async ({ path: at }) => void put(at, 'folder'),
    moveEntry: async ({ from, to }) => {
      const moving = files.get(from);
      if (moving === undefined) throw new Error('nothing to move');
      files.delete(from);
      put(to, moving);
    },
    trashEntry: async ({ path: at }) => void files.delete(at),
  });
  const ownWrites = createOwnWrites({ clock: { now: () => wallClock } });
  const fs = recordingOwnWrites({ fs: host, ownWrites, vault: VAULT });
  const outside = {
    write: (at: string, text: string) => put(at, { text, modified: disk.mtime }),
    remove: (at: string) => {
      files.delete(at);
      folders.delete(at);
    },
    folder: (at: string) => put(at, 'folder'),
    move: (from: string, to: string) => {
      const moving = files.get(from);
      if (moving !== undefined) put(to, moving);
      files.delete(from);
    },
  };
  /** The watcher's report, once the index has been refreshed for every write so far (unless told not). */
  const reported = (paths: readonly string[], { vault = VAULT, refreshedFirst = true } = {}) => {
    if (refreshedFirst) ownWrites.refreshed({ vault: VAULT, through: ownWrites.lastWrite() });
    return outsideChanges({ fs: host, ownWrites, vault, paths });
  };
  return {
    fs,
    host,
    disk,
    outside,
    ownWrites,
    reported,
    wait: (ms: number) => void (wallClock += ms),
  };
}

/** What the watcher reports of a save: its temporary beside the note, and the note. */
const saveReport = (note: string) => {
  const slash = note.lastIndexOf('/');
  return [`${note.slice(0, slash + 1)}.${note.slice(slash + 1)}.atlas-tmp`, note];
};

const save = (fs: VaultFsPort, at: string, contents: string) =>
  fs.writeTextFile({ path: path(at), contents, expectedModified: null });

describe('outsideChanges: the echo of the app’s own write is dropped (#254)', () => {
  it('drops the report of a save, its temporary included', async () => {
    const vault = aVault();
    await save(vault.fs, 'Notes/Plan.md', '# Plan\n');
    expect(await vault.reported(saveReport('Notes/Plan.md'))).toEqual([]);
  });

  it('keeps the note of a save the app has not refreshed for, which its echo refreshes', async () => {
    const vault = aVault();
    await save(vault.fs, 'Notes/Plan.md', '# Plan\n');
    // An autosave: nothing but the watcher's report puts it in the index.
    expect(await vault.reported(saveReport('Notes/Plan.md'), { refreshedFirst: false })).toEqual([
      'Notes/Plan.md',
    ]);
  });

  it('keeps a save that landed after the refresh it would be dropped against began', async () => {
    const vault = aVault();
    await save(vault.fs, 'Notes/Plan.md', '# Plan\n');
    const began = vault.ownWrites.lastWrite();
    await save(vault.fs, 'Notes/Other.md', '# Other\n');
    vault.ownWrites.refreshed({ vault: VAULT, through: began });
    expect(
      await vault.reported(['Notes/Plan.md', 'Notes/Other.md'], { refreshedFirst: false }),
    ).toEqual(['Notes/Other.md']);
  });

  it('reads nothing for a report the app wrote none of', async () => {
    const vault = aVault();
    vault.outside.write('Notes/Theirs.md', '# Theirs\n');
    expect(await vault.reported(['Notes/Theirs.md'])).toEqual(['Notes/Theirs.md']);
    expect(vault.disk.reads).toBe(0);
  });

  it('keeps another program’s save in the same millisecond as the app’s', async () => {
    const vault = aVault();
    await save(vault.fs, 'Notes/Plan.md', '# Plan\n');
    vault.outside.write('Notes/Plan.md', '# Plan, theirs\n');
    expect(await vault.reported(saveReport('Notes/Plan.md'))).toEqual(['Notes/Plan.md']);
  });

  it('keeps a change on a coarse-clock disk that kept the time and the length', async () => {
    const vault = aVault();
    vault.disk.mtime = 2_000; // A whole second, as HFS+ keeps it.
    await save(vault.fs, 'Notes/Plan.md', '# Plan A\n');
    vault.outside.write('Notes/Plan.md', '# Plan B\n');
    expect(await vault.reported(['Notes/Plan.md'])).toEqual(['Notes/Plan.md']);
  });

  it('keeps a note written again with the same bytes at a later time', async () => {
    const vault = aVault();
    await save(vault.fs, 'Notes/Plan.md', '# Plan\n');
    vault.disk.mtime += 1;
    vault.outside.write('Notes/Plan.md', '# Plan\n');
    expect(await vault.reported(['Notes/Plan.md'])).toEqual(['Notes/Plan.md']);
  });

  it('drops only the echoes of a burst of saves, keeping the one change from outside in it', async () => {
    const vault = aVault();
    const notes = Array.from({ length: 40 }, (_, at) => `Tasks/Task ${at}.md`);
    for (const [at, note] of notes.entries()) {
      vault.disk.mtime += 1;
      await save(vault.fs, note, `# Task ${at}\n`);
    }
    // The same note saved again and again: its last save is what is on disk.
    for (const text of ['one', 'two', 'three']) await save(vault.fs, notes[0] ?? '', text);
    vault.outside.write('Tasks/Task 7.md', '# Task 7, theirs\n');
    const report = notes.flatMap(saveReport);
    expect(await vault.reported(report)).toEqual(['Tasks/Task 7.md']);
    // One read for all the notes, however many.
    expect(vault.disk.reads).toBe(1);
  });

  it('keeps the oldest saves of a burst past what it remembers', async () => {
    const vault = aVault();
    const ownWrites = createOwnWrites({ clock: { now: () => 0 }, capacity: 2 });
    const fs = recordingOwnWrites({ fs: vault.host, ownWrites, vault: VAULT });
    for (const note of ['a.md', 'b.md', 'c.md']) await save(fs, note, note);
    ownWrites.refreshed({ vault: VAULT, through: ownWrites.lastWrite() });
    const left = await outsideChanges({
      fs: vault.host,
      ownWrites,
      vault: VAULT,
      paths: ['a.md', 'b.md', 'c.md'],
    });
    expect(left).toEqual(['a.md']);
  });

  it('keeps a report that comes after the app’s write has expired', async () => {
    const vault = aVault();
    await save(vault.fs, 'Notes/Plan.md', '# Plan\n');
    vault.wait(OWN_WRITE_KEPT_MS + 1);
    expect(await vault.reported(saveReport('Notes/Plan.md'))).toEqual(saveReport('Notes/Plan.md'));
  });

  it('keeps the report in another vault, of a path the app wrote in this one', async () => {
    const vault = aVault();
    await save(vault.fs, 'Notes/Plan.md', '# Plan\n');
    expect(await vault.reported(saveReport('Notes/Plan.md'), { vault: OTHER_VAULT })).toEqual(
      saveReport('Notes/Plan.md'),
    );
  });

  it('keeps every path it could not read', async () => {
    const vault = aVault();
    await save(vault.fs, 'Notes/Plan.md', '# Plan\n');
    await vault.fs.trashEntry({ path: path('Notes/Old.md') });
    vault.disk.failReads = true;
    expect(await vault.reported(['Notes/Plan.md', 'Notes/Old.md'])).toEqual([
      'Notes/Plan.md',
      'Notes/Old.md',
    ]);
  });

  it('keeps a temporary beside a note the app did not save', async () => {
    const vault = aVault();
    expect(await vault.reported(['Notes/.Plan.md.atlas-tmp'])).toEqual([
      'Notes/.Plan.md.atlas-tmp',
    ]);
  });
});

describe('outsideChanges: renames, deletes and creates', () => {
  it('drops the report of the app’s own move of a note it saved', async () => {
    const vault = aVault();
    await save(vault.fs, 'Inbox/Call.md', '# Call\n');
    await vault.fs.createFolder({ path: path('Projects') });
    await vault.fs.moveEntry({ from: path('Inbox/Call.md'), to: path('Projects/Call.md') });
    const report = [...saveReport('Inbox/Call.md'), 'Projects', 'Projects/Call.md'];
    // The new folder holds only the note the app moved in, as it left it.
    expect(await vault.reported(report)).toEqual([]);
  });

  it('keeps the moved note when the app never saw its bytes', async () => {
    const vault = aVault();
    vault.outside.write('Inbox/Call.md', '# Call\n');
    await vault.fs.moveEntry({ from: path('Inbox/Call.md'), to: path('Archive.md') });
    expect(await vault.reported(['Inbox/Call.md', 'Archive.md'])).toEqual(['Archive.md']);
  });

  it('keeps another program renaming the note the app just saved', async () => {
    const vault = aVault();
    await save(vault.fs, 'Notes/Plan.md', '# Plan\n');
    vault.outside.move('Notes/Plan.md', 'Notes/Plan 2.md');
    expect(await vault.reported(['Notes/Plan.md', 'Notes/Plan 2.md'])).toEqual([
      'Notes/Plan.md',
      'Notes/Plan 2.md',
    ]);
  });

  it('keeps another program deleting the note the app just saved', async () => {
    const vault = aVault();
    await save(vault.fs, 'Notes/Plan.md', '# Plan\n');
    vault.outside.remove('Notes/Plan.md');
    expect(await vault.reported(['Notes/Plan.md'])).toEqual(['Notes/Plan.md']);
  });

  it('drops the report of the app’s own trash, and keeps a note made there since', async () => {
    const vault = aVault();
    vault.outside.write('Notes/Old.md', '# Old\n');
    await vault.fs.trashEntry({ path: path('Notes/Old.md') });
    expect(await vault.reported(['Notes/Old.md'])).toEqual([]);
    vault.outside.write('Notes/Old.md', '# Old, again\n');
    expect(await vault.reported(['Notes/Old.md'])).toEqual(['Notes/Old.md']);
  });

  it('keeps a folder made where the app trashed a note', async () => {
    const vault = aVault();
    vault.outside.write('Old.md', '# Old\n');
    await vault.fs.trashEntry({ path: path('Old.md') });
    vault.outside.folder('Old.md');
    expect(await vault.reported(['Old.md'])).toEqual(['Old.md']);
  });

  it('drops the app’s own new folder while it is empty or holds only the app’s notes', async () => {
    const vault = aVault();
    await vault.fs.createFolder({ path: path('Projects/Larkspur') });
    expect(await vault.reported(['Projects/Larkspur'])).toEqual([]);
    await save(vault.fs, 'Projects/Larkspur/Plan.md', '# Plan\n');
    expect(await vault.reported(['Projects/Larkspur'])).toEqual([]);
  });

  it('keeps the app’s own new folder once another program has put anything in it', async () => {
    const vault = aVault();
    await vault.fs.createFolder({ path: path('Projects/Larkspur') });
    await save(vault.fs, 'Projects/Larkspur/Plan.md', '# Plan\n');
    vault.outside.write('Projects/Larkspur/Notes.md', '# Notes\n');
    expect(await vault.reported(['Projects/Larkspur'])).toEqual(['Projects/Larkspur']);
    vault.outside.remove('Projects/Larkspur/Notes.md');
    vault.outside.write('Projects/Larkspur/Plan.md', '# Plan, theirs\n');
    expect(await vault.reported(['Projects/Larkspur'])).toEqual(['Projects/Larkspur']);
    vault.outside.remove('Projects/Larkspur/Plan.md');
    vault.outside.remove('Projects/Larkspur');
    expect(await vault.reported(['Projects/Larkspur'])).toEqual(['Projects/Larkspur']);
  });

  it('drops the folders a filing made inside one another, holding only the note it filed', async () => {
    const vault = aVault();
    await save(vault.fs, 'Inbox/Call.md', '# Call\n');
    for (const each of ['Tasks', 'Tasks/2026', 'Tasks/2026/10']) {
      await vault.fs.createFolder({ path: path(each) });
    }
    await vault.fs.moveEntry({ from: path('Inbox/Call.md'), to: path('Tasks/2026/10/Call.md') });
    const report = [
      'Tasks',
      'Tasks/2026',
      'Tasks/2026/10',
      'Inbox/Call.md',
      'Tasks/2026/10/Call.md',
    ];
    expect(await vault.reported(report)).toEqual([]);
    // A note from elsewhere in the deepest one makes every folder above it someone else's too.
    vault.outside.write('Tasks/2026/10/Theirs.md', '# Theirs\n');
    expect(await vault.reported(report)).toEqual(['Tasks', 'Tasks/2026', 'Tasks/2026/10']);
  });

  it('keeps the app’s new folder once anything that is not the app’s note is in it', async () => {
    const vault = aVault();
    await vault.fs.createFolder({ path: path('Projects/Larkspur') });
    await save(vault.fs, 'Projects/Larkspur/Plan.md', '# Plan\n');
    vault.outside.write('Projects/Larkspur/.DS_Store', 'Bud1');
    vault.disk.reads = 0;
    expect(await vault.reported(['Projects/Larkspur'])).toEqual(['Projects/Larkspur']);
    // The note the app left is read back; the stranger in the folder is not.
    expect(vault.disk.readPaths).toEqual(['Projects/Larkspur/Plan.md']);
  });

  it('keeps the app’s new folder once another program has made an empty folder in it', async () => {
    const vault = aVault();
    await vault.fs.createFolder({ path: path('Projects/Larkspur') });
    vault.outside.folder('Projects/Larkspur/Scans');
    expect(await vault.reported(['Projects/Larkspur'])).toEqual(['Projects/Larkspur']);
  });

  it('keeps the app’s new folder when it cannot be listed', async () => {
    const vault = aVault();
    await vault.fs.createFolder({ path: path('Projects/Larkspur') });
    vault.disk.failListings = true;
    expect(await vault.reported(['Projects/Larkspur'])).toEqual(['Projects/Larkspur']);
  });

  it('keeps the app’s new folder holding one it made that the report leaves out, which is not listed', async () => {
    const vault = aVault();
    await vault.fs.createFolder({ path: path('Tasks') });
    await vault.fs.createFolder({ path: path('Tasks/2026') });
    await save(vault.fs, 'Tasks/2026/Plan.md', '# Plan\n');
    // Only what a report names is listed: what the folder inside holds is not known.
    expect(await vault.reported(['Tasks'])).toEqual(['Tasks']);
  });

  it('keeps a new folder past what it lists, rather than list more', async () => {
    const vault = aVault();
    const made = ['A', 'B', 'C', 'D', 'E'];
    for (const each of made) await vault.fs.createFolder({ path: path(each) });
    expect(await vault.reported(made)).toEqual(made);
  });

  it('refreshes for a burst of trashes across more folders than it lists, after one read', async () => {
    const vault = aVault();
    const trashed = ['A/Old.md', 'B/Old.md', 'C/Old.md', 'D/Old.md', 'E/Old.md'];
    for (const each of trashed) {
      vault.outside.write(each, '# Old\n');
      await vault.fs.trashEntry({ path: path(each) });
    }
    vault.disk.reads = 0;
    // Five folders to list: no note is read back, and an empty path cannot be told from one the read skips.
    expect(await vault.reported(trashed)).toEqual(trashed);
    expect(vault.disk.reads).toBe(1);
  });

  it('keeps what the read skips at a path the app emptied, past the folders it lists', async () => {
    const vault = aVault();
    const trashed = ['A/Old.md', 'B/Old.md', 'C/Old.md', 'D/Old.md', 'E/Old.md'];
    for (const each of trashed) {
      vault.outside.write(each, '# Old\n');
      await vault.fs.trashEntry({ path: path(each) });
    }
    // Put back as something the host's read leaves out: too big, not text, or a folder.
    vault.outside.folder('C/Old.md');
    expect(await vault.reported(['C/Old.md', ...trashed])).toContain('C/Old.md');
  });

  it('drops the app’s trashes, read and listed, while there are few folders', async () => {
    const vault = aVault();
    const trashed = ['A/Old.md', 'A/Older.md', 'B/Old.md'];
    for (const each of trashed) {
      vault.outside.write(each, '# Old\n');
      await vault.fs.trashEntry({ path: path(each) });
    }
    vault.disk.reads = 0;
    expect(await vault.reported(trashed)).toEqual([]);
    // One read, and one listing of each of the two folders.
    expect(vault.disk.reads).toBe(3);
  });

  it('keeps a note another program creates', async () => {
    const vault = aVault();
    await save(vault.fs, 'Notes/Plan.md', '# Plan\n');
    vault.outside.write('Notes/New.md', '# New\n');
    expect(await vault.reported([...saveReport('Notes/Plan.md'), 'Notes/New.md'])).toEqual([
      'Notes/New.md',
    ]);
  });
});

describe('outsideChanges: the app’s own new note (#258)', () => {
  const create = (fs: VaultFsPort, at: string, contents: string) =>
    fs.createNote({ path: path(at), contents });

  it('drops the report of the app’s new note, its temporary included', async () => {
    const vault = aVault();
    await create(vault.fs, 'Inbox/Buy flour.md', '# Buy flour\n');
    expect(await vault.reported(saveReport('Inbox/Buy flour.md'))).toEqual([]);
  });

  it('keeps the app’s new note it has not refreshed for, which its echo refreshes', async () => {
    const vault = aVault();
    await create(vault.fs, 'Inbox/Buy flour.md', '# Buy flour\n');
    expect(
      await vault.reported(saveReport('Inbox/Buy flour.md'), { refreshedFirst: false }),
    ).toEqual(['Inbox/Buy flour.md']);
  });

  it('keeps another program’s write over the new note in the same millisecond', async () => {
    const vault = aVault();
    await create(vault.fs, 'Inbox/Buy flour.md', '# Buy flour\n');
    vault.outside.write('Inbox/Buy flour.md', '# Buy flour, theirs\n');
    expect(await vault.reported(saveReport('Inbox/Buy flour.md'))).toEqual(['Inbox/Buy flour.md']);
  });

  it('keeps another program’s write over the new note with the same bytes at a later time', async () => {
    const vault = aVault();
    await create(vault.fs, 'Inbox/Buy flour.md', '# Buy flour\n');
    vault.disk.mtime += 5;
    vault.outside.write('Inbox/Buy flour.md', '# Buy flour\n');
    expect(await vault.reported(['Inbox/Buy flour.md'])).toEqual(['Inbox/Buy flour.md']);
  });

  it('keeps another program’s note at a path the app’s create was refused at', async () => {
    const vault = aVault();
    await create(vault.fs, 'Inbox/Buy flour.md', '# Buy flour\n');
    vault.outside.write('Inbox/Buy flour.md', '# Theirs\n');
    const refusing = recordingOwnWrites({
      fs: fakeVaultFs({
        createNote: async () => {
          throw new Error('a note with that name already exists');
        },
      }),
      ownWrites: vault.ownWrites,
      vault: VAULT,
    });
    await expect(create(refusing, 'Inbox/Buy flour.md', '# Buy flour\n')).rejects.toThrow(
      'already exists',
    );
    expect(vault.ownWrites.leftAt({ vault: VAULT, path: 'Inbox/Buy flour.md' })).toBeNull();
    expect(await vault.reported(['Inbox/Buy flour.md'])).toEqual(['Inbox/Buy flour.md']);
  });

  it('drops the echo of a new note that a second create of the app’s was refused over', async () => {
    // Two of the app's writes of one file race — the Block type, as a vault
    // opens on a busy machine — and the host refuses the second: it changed
    // nothing, so what the first left is still what is there.
    const vault = aVault();
    await create(vault.fs, '.atlas/types/block.md', '# Block\n');
    const refusing = recordingOwnWrites({
      fs: fakeVaultFs({
        createNote: async () => {
          throw new Error('a note with that name already exists');
        },
      }),
      ownWrites: vault.ownWrites,
      vault: VAULT,
    });
    await expect(create(refusing, '.atlas/types/block.md', '# Block\n')).rejects.toThrow(
      'already exists',
    );
    expect(await vault.reported(saveReport('.atlas/types/block.md'))).toEqual([]);
  });

  it('keeps a new note in a vault other than the one the app made its note in', async () => {
    const vault = aVault();
    await create(vault.fs, 'Inbox/Buy flour.md', '# Buy flour\n');
    expect(await vault.reported(['Inbox/Buy flour.md'], { vault: OTHER_VAULT })).toEqual([
      'Inbox/Buy flour.md',
    ]);
  });

  it('passes on the time the host reports for the new note', async () => {
    const vault = aVault();
    vault.disk.mtime = 4_321;
    expect(await create(vault.fs, 'Inbox/Buy flour.md', '# Buy flour\n')).toBe(4_321);
  });
});

describe('recordingOwnWrites: a write that fails is not the app’s', () => {
  it('forgets a note whose save the host refused, and passes the refusal on', async () => {
    const vault = aVault();
    await save(vault.fs, 'Notes/Plan.md', '# Plan\n');
    const refusing = recordingOwnWrites({
      fs: fakeVaultFs({
        writeTextFile: async () => {
          throw new Error('the note changed on disk since it was opened');
        },
      }),
      ownWrites: vault.ownWrites,
      vault: VAULT,
    });
    await expect(save(refusing, 'Notes/Plan.md', '# Plan, again\n')).rejects.toThrow(
      'changed on disk',
    );
    expect(vault.ownWrites.leftAt({ vault: VAULT, path: 'Notes/Plan.md' })).toBeNull();
  });

  it('forgets both ends of a move that failed', async () => {
    const vault = aVault();
    await save(vault.fs, 'Notes/Plan.md', '# Plan\n');
    await expect(
      vault.fs.moveEntry({ from: path('Notes/Gone.md'), to: path('Notes/Plan.md') }),
    ).rejects.toThrow('nothing to move');
    expect(vault.ownWrites.leftAt({ vault: VAULT, path: 'Notes/Plan.md' })).toBeNull();
  });

  it('forgets an artifact’s bytes, which it cannot compare', async () => {
    const vault = aVault();
    await vault.fs.createFolder({ path: path('Files') });
    await vault.fs.writeBinaryFile({
      path: path('Files'),
      bytes: new Uint8Array([1]),
      offset: 0,
    });
    expect(vault.ownWrites.leftAt({ vault: VAULT, path: 'Files' })).toBeNull();
  });

  it('reads through to the host it wraps', async () => {
    const vault = aVault();
    vault.outside.write('Notes/Plan.md', '# Plan\n');
    const [read] = await vault.fs.readNotes(['Notes/Plan.md']);
    expect(read?.text).toBe('# Plan\n');
  });
});

describe('awaitsOwnRefresh: whether a report is worth waiting on the app’s refresh for', () => {
  const reportOf = (ownWrites: ReturnType<typeof createOwnWrites>, paths: string[]) =>
    awaitsOwnRefresh({ ownWrites, vault: VAULT, paths });
  const text = { kind: 'text', text: '# Plan\n', modified: 1 } as const;

  it('waits for a write of the app’s that no refresh has taken in, or its temporary', () => {
    const ownWrites = createOwnWrites({ clock: { now: () => 0 } });
    ownWrites.record({ vault: VAULT, path: 'Notes/Plan.md', left: text });
    expect(reportOf(ownWrites, ['Notes/Theirs.md', 'Notes/Plan.md'])).toBe(true);
    expect(reportOf(ownWrites, ['Notes/.Plan.md.atlas-tmp'])).toBe(true);
  });

  it('does not wait for other programs’ changes, nor a write already refreshed for', () => {
    const ownWrites = createOwnWrites({ clock: { now: () => 0 } });
    ownWrites.record({ vault: VAULT, path: 'Notes/Plan.md', left: text });
    expect(reportOf(ownWrites, ['Notes/Theirs.md'])).toBe(false);
    expect(awaitsOwnRefresh({ ownWrites, vault: OTHER_VAULT, paths: ['Notes/Plan.md'] })).toBe(
      false,
    );
    ownWrites.refreshed({ vault: VAULT, through: ownWrites.lastWrite() });
    expect(reportOf(ownWrites, saveReport('Notes/Plan.md'))).toBe(false);
  });
});
