import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  movedPath,
  parentVaultPath,
  resolveWikiLinkTarget,
  vaultPathName,
  type EntryMove,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { createNote } from '../notes/create-note.ts';
import { createFolder, listVaultFolders } from './create-folder.ts';
import { countOtherFiles, deleteEntry, previewDeletion } from './delete-entry.ts';
import { moveEntryInto, renameEntry, MoveRefusedError } from './relocate-entry.ts';
import { VaultAccessError, type OpenEditorsPort } from './ports.ts';

const path = (raw: string) => createVaultPath(raw);
const note = (raw: string) => ({ path: path(raw), kind: 'file' as const });
const folder = (raw: string) => ({ path: path(raw), kind: 'directory' as const });

/**
 * A vault held as two sets, folders and notes, answering the way the host
 * does: moves and creations refuse to overwrite, the Trash takes a folder whole.
 */
function memoryVault({ folders = [], notes = [] }: { folders?: string[]; notes?: string[] }) {
  const dirs = new Set<string>(folders);
  const files = new Set<string>(notes);
  const trash: string[] = [];
  const log: string[] = [];
  const exists = (at: string) => dirs.has(at) || files.has(at);
  const under = (from: string) => (at: string) => at === from || at.startsWith(`${from}/`);
  const shift = (set: Set<string>, move: EntryMove) => {
    for (const at of [...set]) {
      const to = movedPath(at as VaultPath, move);
      if (to !== null) {
        set.delete(at);
        set.add(to);
      }
    }
  };
  const entry = (at: string, kind: 'file' | 'directory'): VaultEntry =>
    ({ kind, name: vaultPathName(path(at)), path: path(at) }) as VaultEntry;

  const fs = fakeVaultFs({
    listDirectory: async (parent) => [
      ...[...dirs]
        .filter((at) => parentVaultPath(path(at)) === parent)
        .map((at) => entry(at, 'directory')),
      ...[...files]
        .filter((at) => parentVaultPath(path(at)) === parent)
        .map((at) => entry(at, 'file')),
    ],
    createFolder: async ({ path: at }) => {
      if (exists(at)) throw new VaultAccessError('something with that name is already there');
      dirs.add(at);
      log.push(`mkdir ${at}`);
    },
    createNote: async ({ path: at }) => {
      if (exists(at)) throw new VaultAccessError('a note with that name already exists');
      files.add(at);
      log.push(`create ${at}`);
      return 0;
    },
    moveEntry: async (move) => {
      if (!exists(move.from)) throw new VaultAccessError('no such entry');
      if (exists(move.to)) throw new VaultAccessError('something with that name is already there');
      shift(dirs, move);
      shift(files, move);
      log.push(`move ${move.from} -> ${move.to}`);
    },
    trashEntry: async ({ path: at }) => {
      if (!exists(at)) throw new VaultAccessError('no such entry');
      for (const set of [dirs, files]) {
        for (const each of [...set].filter(under(at))) set.delete(each);
      }
      trash.push(at);
      log.push(`trash ${at}`);
    },
  });
  return { fs, dirs, files, trash, log, notePaths: () => [...files].map(path) };
}

/** Panes as the move sees them: which notes are open, which have unsaved typing. */
function panes({ dirty = [], log }: { dirty?: string[]; log: string[] }) {
  const unsaved = new Set(dirty);
  const editors: OpenEditorsPort = {
    state: (at) => (unsaved.has(at) ? 'dirty' : 'closed'),
    flush: async (paths) => {
      for (const at of paths.filter((each) => unsaved.has(each))) log.push(`flush ${at}`);
    },
    follow: (move) => log.push(`follow ${move.from} -> ${move.to}`),
    abandon: (paths) => log.push(`abandon ${paths.join(',')}`),
  };
  return editors;
}

function indexKeeping(log: string[]) {
  return fakeIndexPort({
    remove: async (paths) => {
      log.push(`unindex ${paths.join(',')}`);
    },
  });
}

describe('moving a note into a folder', () => {
  it('writes unsaved typing first, moves the file, then re-points the panes and the index', async () => {
    const vault = memoryVault({ folders: ['Projects'], notes: ['Plan.md'] });
    const ports = {
      fs: vault.fs,
      index: indexKeeping(vault.log),
      editors: panes({ dirty: ['Plan.md'], log: vault.log }),
    };

    const moved = await moveEntryInto({
      ports,
      entry: note('Plan.md'),
      folder: path('Projects'),
      notePaths: vault.notePaths(),
    });

    expect(moved.move).toEqual({ from: 'Plan.md', to: 'Projects/Plan.md' });
    expect(vault.log).toEqual([
      'flush Plan.md',
      'move Plan.md -> Projects/Plan.md',
      'follow Plan.md -> Projects/Plan.md',
      'unindex Plan.md',
    ]);
    expect(vault.files).toEqual(new Set(['Projects/Plan.md']));
  });

  it('keeps [[links]] to it working, since they name the note and not its folder', async () => {
    const vault = memoryVault({ folders: ['Projects'], notes: ['Plan.md', 'Inbox.md'] });
    const ports = { fs: vault.fs, index: fakeIndexPort(), editors: panes({ log: [] }) };

    const moved = await moveEntryInto({
      ports,
      entry: note('Plan.md'),
      folder: path('Projects'),
      notePaths: vault.notePaths(),
    });

    expect(resolveWikiLinkTarget('Plan', vault.notePaths())).toBe('Projects/Plan.md');
    expect(moved.clashes).toEqual([]);
  });

  it('warns when the move changes which of two same-named notes [[Plan]] opens', async () => {
    const vault = memoryVault({
      folders: ['Notes', 'Deep', 'Deep/Er'],
      notes: ['Notes/Plan.md', 'Deep/Er/Plan.md'],
    });
    const ports = { fs: vault.fs, index: fakeIndexPort(), editors: panes({ log: [] }) };

    const moved = await moveEntryInto({
      ports,
      entry: note('Deep/Er/Plan.md'),
      folder: path(''),
      notePaths: vault.notePaths(),
    });
    expect(moved.clashes).toEqual([{ name: 'Plan', opens: 'Plan.md' }]);
  });

  it('refuses a folder the domain rules out, before touching anything', async () => {
    const vault = memoryVault({ folders: ['Projects', 'Projects/DFAI'], notes: [] });
    const ports = { fs: vault.fs, index: fakeIndexPort(), editors: panes({ log: vault.log }) };

    await expect(
      moveEntryInto({
        ports,
        entry: folder('Projects'),
        folder: path('Projects/DFAI'),
        notePaths: [],
      }),
    ).rejects.toBeInstanceOf(MoveRefusedError);
    await expect(
      moveEntryInto({
        ports,
        entry: note('.atlas/dashboards/Home.md'),
        folder: path('Projects'),
        notePaths: [],
      }),
    ).rejects.toThrow('DFAI keeps');
    expect(vault.log).toEqual([]);
  });

  it('passes on a collision the disk refuses, and re-points nothing', async () => {
    const vault = memoryVault({ folders: ['Projects'], notes: ['Plan.md', 'Projects/Plan.md'] });
    const ports = { fs: vault.fs, index: fakeIndexPort(), editors: panes({ log: vault.log }) };

    await expect(
      moveEntryInto({
        ports,
        entry: note('Plan.md'),
        folder: path('Projects'),
        notePaths: vault.notePaths(),
      }),
    ).rejects.toThrow('already there');
    expect(vault.log.filter((line) => line.startsWith('follow'))).toEqual([]);
    expect(vault.files).toEqual(new Set(['Plan.md', 'Projects/Plan.md']));
  });

  it('still lands when the index cannot forget the old path', async () => {
    const vault = memoryVault({ folders: ['Projects'], notes: ['Plan.md'] });
    const index = fakeIndexPort({ remove: () => Promise.reject(new Error('index busy')) });
    const ports = { fs: vault.fs, index, editors: panes({ log: [] }) };

    await moveEntryInto({
      ports,
      entry: note('Plan.md'),
      folder: path('Projects'),
      notePaths: vault.notePaths(),
    });
    expect(vault.files).toEqual(new Set(['Projects/Plan.md']));
  });
});

describe('moving a folder', () => {
  it('carries every note under it, and re-points the panes on any of them', async () => {
    const vault = memoryVault({
      folders: ['Projects', 'Projects/DFAI', 'Attic'],
      notes: ['Projects/DFAI/plan.md', 'Projects/a.md', 'Other.md'],
    });
    const ports = {
      fs: vault.fs,
      index: indexKeeping(vault.log),
      editors: panes({ dirty: ['Projects/a.md'], log: vault.log }),
    };

    await moveEntryInto({
      ports,
      entry: folder('Projects'),
      folder: path('Attic'),
      notePaths: vault.notePaths(),
    });

    expect(vault.files).toEqual(
      new Set(['Attic/Projects/DFAI/plan.md', 'Attic/Projects/a.md', 'Other.md']),
    );
    expect(vault.log).toEqual([
      'flush Projects/a.md',
      'move Projects -> Attic/Projects',
      'follow Projects -> Attic/Projects',
      'unindex Projects/DFAI/plan.md,Projects/a.md',
    ]);
  });
});

describe('renaming', () => {
  it('renames a note, numbering a name that is taken', async () => {
    const vault = memoryVault({ notes: ['Draft.md', 'Plan.md'] });
    const ports = { fs: vault.fs, index: fakeIndexPort(), editors: panes({ log: vault.log }) };

    const renamed = await renameEntry({
      ports,
      entry: note('Draft.md'),
      name: 'Plan',
      notePaths: vault.notePaths(),
    });
    expect(renamed?.move.to).toBe('Plan 2.md');
    expect(vault.log).toContain('follow Draft.md -> Plan 2.md');
  });

  it('does nothing when the name is what it already is', async () => {
    const vault = memoryVault({ notes: ['Plan.md'] });
    const ports = { fs: vault.fs, index: fakeIndexPort(), editors: panes({ log: vault.log }) };
    await expect(
      renameEntry({ ports, entry: note('Plan.md'), name: 'Plan', notePaths: vault.notePaths() }),
    ).resolves.toBeNull();
    expect(vault.log).toEqual([]);
  });

  it('changes only the case when only the case was changed', async () => {
    const vault = memoryVault({ notes: ['plan.md'] });
    const ports = { fs: vault.fs, index: fakeIndexPort(), editors: panes({ log: [] }) };
    const renamed = await renameEntry({
      ports,
      entry: note('plan.md'),
      name: 'Plan',
      notePaths: vault.notePaths(),
    });
    expect(renamed?.move.to).toBe('Plan.md');
  });

  it('warns when a note is renamed to a name another note has', async () => {
    const vault = memoryVault({ folders: ['Projects'], notes: ['Plan.md', 'Projects/Draft.md'] });
    const ports = { fs: vault.fs, index: fakeIndexPort(), editors: panes({ log: [] }) };
    const renamed = await renameEntry({
      ports,
      entry: note('Projects/Draft.md'),
      name: 'Plan',
      notePaths: vault.notePaths(),
    });
    expect(renamed?.clashes).toEqual([{ name: 'Plan', opens: 'Plan.md' }]);
  });

  it('renames a folder, numbering past a sibling folder or note', async () => {
    const vault = memoryVault({ folders: ['Old', 'Work'], notes: ['Old/a.md', 'Work.md'] });
    const ports = { fs: vault.fs, index: fakeIndexPort(), editors: panes({ log: vault.log }) };

    const renamed = await renameEntry({
      ports,
      entry: folder('Old'),
      name: 'Work',
      notePaths: vault.notePaths(),
    });
    expect(renamed?.move).toEqual({ from: 'Old', to: 'Work 2' });
    expect(vault.files.has('Work 2/a.md')).toBe(true);
  });

  it('keeps the names of DFAI’s own folders', async () => {
    const vault = memoryVault({ folders: ['.atlas', '.atlas/views'] });
    const ports = { fs: vault.fs, index: fakeIndexPort(), editors: panes({ log: vault.log }) };
    await expect(
      renameEntry({ ports, entry: folder('.atlas/views'), name: 'Mine', notePaths: [] }),
    ).rejects.toThrow('DFAI needs');
  });
});

describe('a template is not renamed by a note flow (issue #15)', () => {
  it('refuses to rename a template from its title, and leaves it where it is', async () => {
    const vault = memoryVault({
      folders: ['.atlas', '.atlas/templates'],
      notes: ['.atlas/templates/Company.md'],
    });
    const ports = { fs: vault.fs, index: fakeIndexPort(), editors: panes({ log: vault.log }) };

    await expect(
      renameEntry({
        ports,
        entry: note('.atlas/templates/Company.md'),
        name: 'Larkspur Payroll',
        notePaths: vault.notePaths(),
      }),
    ).rejects.toBeInstanceOf(MoveRefusedError);
    expect(vault.log).toEqual([]);
    expect(vault.notePaths()).toEqual(['.atlas/templates/Company.md']);
  });
});

describe('deleting', () => {
  it('asks about a note with unsaved typing before anything goes', () => {
    const log: string[] = [];
    const preview = previewDeletion({
      entry: folder('Projects'),
      notePaths: [path('Projects/a.md'), path('Projects/b.md'), path('c.md')],
      editors: panes({ dirty: ['Projects/b.md'], log }),
    });
    expect(preview).toEqual({
      notes: ['Projects/a.md', 'Projects/b.md'],
      unsaved: ['Projects/b.md'],
      refusal: null,
    });
    expect(log).toEqual([]);
  });

  it('counts every file a folder would take that is not one of its notes, at any depth', async () => {
    const vault = memoryVault({
      folders: ['Old', 'Old/assets', 'Old/assets/raw', 'Keep'],
      notes: ['Old/a.md', 'Old/assets/b.png', 'Old/assets/raw/c.pdf', 'Old/d.txt', 'Keep/e.png'],
    });
    const others = await countOtherFiles({
      fs: vault.fs,
      entry: folder('Old'),
      notes: [path('Old/a.md')],
    });
    expect(others).toEqual({ link: false, count: 3, links: [] });
  });

  it('counts nothing else for a note', async () => {
    const vault = memoryVault({ notes: ['a.md', 'b.png'] });
    const note = { path: path('a.md'), kind: 'file' as const };
    expect(await countOtherFiles({ fs: vault.fs, entry: note, notes: [note.path] })).toEqual({
      link: false,
      count: 0,
      links: [],
    });
  });

  it('says why DFAI’s own folder cannot go', () => {
    expect(
      previewDeletion({ entry: folder('.atlas'), notePaths: [], editors: panes({ log: [] }) })
        .refusal,
    ).toMatch(/DFAI needs/);
  });

  it('puts a note in the Trash, then lets go of its panes and its index entry', async () => {
    const vault = memoryVault({ notes: ['Plan.md', 'Other.md'] });
    const gone = await deleteEntry({
      fs: vault.fs,
      index: indexKeeping(vault.log),
      editors: panes({ dirty: ['Plan.md'], log: vault.log }),
      entry: note('Plan.md'),
      notePaths: vault.notePaths(),
    });

    expect(gone).toEqual(['Plan.md']);
    expect(vault.trash).toEqual(['Plan.md']);
    expect(vault.files).toEqual(new Set(['Other.md']));
    expect(vault.log).toEqual(['trash Plan.md', 'abandon Plan.md', 'unindex Plan.md']);
  });

  it('deletes a dashboard, which the note list leaves out', async () => {
    const vault = memoryVault({
      folders: ['.atlas', '.atlas/dashboards'],
      notes: ['.atlas/dashboards/Home.md'],
    });
    const gone = await deleteEntry({
      fs: vault.fs,
      index: indexKeeping(vault.log),
      editors: panes({ log: vault.log }),
      entry: note('.atlas/dashboards/Home.md'),
      notePaths: [],
    });
    expect(gone).toEqual(['.atlas/dashboards/Home.md']);
    expect(vault.files.size).toBe(0);
    expect(vault.log).toContain('unindex .atlas/dashboards/Home.md');
  });

  it('puts a folder in the Trash with every note in it', async () => {
    const vault = memoryVault({
      folders: ['Old', 'Old/Deeper'],
      notes: ['Old/a.md', 'Old/Deeper/b.md', 'Kept.md'],
    });
    const gone = await deleteEntry({
      fs: vault.fs,
      index: fakeIndexPort(),
      editors: panes({ log: vault.log }),
      entry: folder('Old'),
      notePaths: vault.notePaths(),
    });
    expect(gone).toEqual(['Old/a.md', 'Old/Deeper/b.md']);
    expect(vault.dirs.size).toBe(0);
    expect(vault.files).toEqual(new Set(['Kept.md']));
  });

  it('keeps unsaved typing when the Trash refuses', async () => {
    const vault = memoryVault({ notes: ['Plan.md'] });
    const fs = { ...vault.fs, trashEntry: () => Promise.reject(new Error('Trash refused')) };
    await expect(
      deleteEntry({
        fs,
        index: fakeIndexPort(),
        editors: panes({ dirty: ['Plan.md'], log: vault.log }),
        entry: note('Plan.md'),
        notePaths: vault.notePaths(),
      }),
    ).rejects.toThrow('Trash refused');
    expect(vault.log).toEqual([]);
    expect(vault.files.has('Plan.md')).toBe(true);
  });

  it('never deletes .atlas or its folders', async () => {
    const vault = memoryVault({ folders: ['.atlas', '.atlas/views'] });
    for (const each of ['.atlas', '.atlas/views']) {
      await expect(
        deleteEntry({
          fs: vault.fs,
          index: fakeIndexPort(),
          editors: panes({ log: vault.log }),
          entry: folder(each),
          notePaths: [],
        }),
      ).rejects.toThrow('DFAI needs');
    }
    expect(vault.trash).toEqual([]);
  });

  it('never deletes or renames the file of a built-in type, and says why', async () => {
    const vault = memoryVault({
      folders: ['.atlas', '.atlas/types'],
      notes: ['.atlas/types/person.md'],
    });
    const editors = panes({ log: vault.log });
    const entry = note('.atlas/types/person.md');
    await expect(
      deleteEntry({ fs: vault.fs, index: fakeIndexPort(), editors, entry, notePaths: [] }),
    ).rejects.toThrow(/built-in types stay/);
    await expect(
      renameEntry({
        ports: { fs: vault.fs, index: fakeIndexPort(), editors },
        entry,
        name: 'people',
        notePaths: [],
      }),
    ).rejects.toThrow(/built-in types stay/);
    expect(vault.trash).toEqual([]);
    expect(vault.files.has('.atlas/types/person.md')).toBe(true);
  });
});

describe('new folders', () => {
  it('makes a New folder, numbered past what is there', async () => {
    const vault = memoryVault({ folders: ['Work', 'Work/New folder'] });
    await expect(createFolder({ fs: vault.fs, parent: path('Work') })).resolves.toBe(
      'Work/New folder 2',
    );
    expect(vault.dirs.has('Work/New folder 2')).toBe(true);
  });

  it('uses the name it is given', async () => {
    const vault = memoryVault({});
    await expect(createFolder({ fs: vault.fs, parent: path(''), name: 'Projects' })).resolves.toBe(
      'Projects',
    );
  });

  it('makes none inside .atlas', async () => {
    const vault = memoryVault({ folders: ['.atlas'] });
    await expect(createFolder({ fs: vault.fs, parent: path('.atlas') })).rejects.toThrow(
      'Only DFAI',
    );
    expect(vault.log).toEqual([]);
  });

  it('takes a new note made inside it', async () => {
    const vault = memoryVault({ folders: ['Projects'], notes: ['Other/Beside.md'] });
    const made = await createNote({
      markdown: fakeMarkdown(),
      today: '2026-10-08',
      fs: vault.fs,
      name: 'Untitled',
      beside: path('Other/Beside.md'),
      folder: path('Projects'),
      notePaths: vault.notePaths(),
    });
    expect(made).toBe('Projects/Untitled.md');
  });
});

describe('the folders a move can choose from', () => {
  it('lists every visible folder at every depth, in name order', async () => {
    const vault = memoryVault({
      folders: ['b', 'a', 'a/inner', '.git', 'node_modules', '.atlas', '.atlas/views'],
      notes: ['a/x.md'],
    });
    expect(await listVaultFolders({ fs: vault.fs })).toEqual(['.atlas', 'a', 'a/inner', 'b']);
  });
});
