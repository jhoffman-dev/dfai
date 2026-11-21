/**
 * #911 round 4: the guard's port, method by method. A read passes through;
 * a write is logged, held and made; a write refused is refused before
 * anything reaches the host; the read-only vault writes nothing. Over the
 * in-memory vault. All names are made up.
 */
import { describe, expect, it, vi } from 'vitest';
import { createVaultPath, type AssistIntent } from '@dfai/domain';
import { automationVault } from '../testing/automation-vault.ts';
import { assistVault, guardedWrites, GuardRefusedError } from './assist-guard.ts';

const NOTE = createVaultPath('Notes/Week.md');
const setUp = () => {
  const vault = automationVault({ today: '2026-11-17', notes: { [NOTE]: 'Week.\n' } });
  const marks: AssistIntent[] = [];
  const guard = guardedWrites(vault.ports, {
    known: new Map(),
    items: new Set(),
    mark: async (about) => void marks.push(about),
  });
  return { vault, guard, marks };
};

describe('guardedWrites, method by method', () => {
  it('passes every read through as the host answers it', async () => {
    const { vault, guard } = setUp();
    const scan = { skipDirectories: [], maxDepth: 9 };
    expect(await guard.ports.fs.listDirectory(createVaultPath('Notes'))).toEqual(
      await vault.ports.fs.listDirectory(createVaultPath('Notes')),
    );
    expect(await guard.ports.fs.listNotes(scan)).toEqual(await vault.ports.fs.listNotes(scan));
    expect(await guard.ports.fs.readNotes([NOTE])).toEqual(await vault.ports.fs.readNotes([NOTE]));
    await expect(guard.ports.fs.listFiles({ ...scan, extension: 'pdf' })).resolves.toBeDefined();
  });

  it('refuses a binary write, and a write to a note never read, before the host sees it', async () => {
    const { vault, guard } = setUp();
    const write = vi.spyOn(vault.ports.fs, 'writeTextFile');
    await expect(
      guard.ports.fs.writeBinaryFile({ path: NOTE, bytes: new Uint8Array(), offset: 0 }),
    ).rejects.toBeInstanceOf(GuardRefusedError);
    await expect(
      guard.ports.fs.writeTextFile({ path: NOTE, contents: 'x', expectedModified: null }),
    ).rejects.toThrow('was not read first');
    expect(write).not.toHaveBeenCalled();
  });

  it('logs, holds and makes a save to a note it read, keeping what the caller asked', async () => {
    const { vault, guard, marks } = setUp();
    const read = await guard.ports.fs.readTextFile(NOTE);
    await guard.ports.fs.writeTextFile({
      path: NOTE,
      contents: 'Mine.\n',
      expectedModified: read.modified,
    });
    expect(vault.files.get(NOTE)).toBe('Mine.\n');
    expect(marks).toMatchObject([{ doing: 'relink', path: NOTE }]);
    // A caller's text that is not on disk is refused, whatever the guard knows.
    await expect(
      guard.ports.fs.writeTextFile({
        path: NOTE,
        contents: 'x',
        expectedModified: null,
        expectedText: 'Week.\n',
      }),
    ).rejects.toThrow('changed while the row was being written');
    expect(guard.rewrites()).toEqual([{ path: NOTE, before: 'Week.\n', after: 'Mine.\n' }]);
  });

  it('passes the panes through, and never saves unsaved typing', async () => {
    const { vault, guard } = setUp();
    const editors = guard.ports.editors;
    expect(editors.state(NOTE)).toBe(vault.ports.editors.state(NOTE));
    expect(editors.dirtyPaths?.()).toEqual([]);
    editors.follow({ from: NOTE, to: createVaultPath('Notes/Month.md') });
    editors.abandon([NOTE]);
    editors.reload(NOTE);
    await expect(editors.flush([NOTE])).resolves.toBeUndefined();
    vault.unsaved.add(NOTE);
    await expect(editors.flush([NOTE])).rejects.toThrow('typing not saved');
  });
});

describe('assistVault', () => {
  it('reads, and refuses every write through its reads before anything is written', async () => {
    const vault = automationVault({ today: '2026-11-17', notes: { [NOTE]: 'Week.\n' } });
    const { reads } = assistVault(vault.ports);
    const read = await reads.fs.readTextFile(NOTE);
    expect(read.text).toBe('Week.\n');
    await expect(
      reads.fs.writeTextFile({ path: NOTE, contents: 'x', expectedModified: read.modified }),
    ).rejects.toThrow('it only reads');
    await expect(
      reads.fs.createNote({ path: createVaultPath('Notes/New.md'), contents: 'x' }),
    ).rejects.toThrow('it only reads');
    expect(vault.files.get(NOTE)).toBe('Week.\n');
    expect(vault.files.has('Notes/New.md')).toBe(false);
  });
});
