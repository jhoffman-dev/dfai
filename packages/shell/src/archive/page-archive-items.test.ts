import { describe, expect, it, vi } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { pageArchiveItems } from './archive-menu.ts';
import type { ArchiveCommands } from './use-archive.ts';

/**
 * #213: a page menu's Archive and Unarchive go through the same commands as
 * every other way of archiving — which archive a PARA note by its value — and
 * Unarchive is offered for a Project archived where it stands.
 */
function items({
  path,
  properties,
  busy = false,
}: {
  path: string | null;
  properties: Record<string, unknown> | null;
  busy?: boolean;
}) {
  const commands: ArchiveCommands = { archive: vi.fn(), unarchive: vi.fn(), busy };
  const menu = pageArchiveItems({
    commands,
    path: path === null ? null : createVaultPath(path),
    properties,
  });
  return { menu, commands };
}

describe('pageArchiveItems', () => {
  it('archives a project through the Archive command, as every way of archiving does', () => {
    const { menu, commands } = items({
      path: 'Projects/DFAI.md',
      properties: { type: 'project', para: 'area' },
    });
    expect(menu.onUnarchive).toBeUndefined();
    menu.onArchive?.();
    expect(commands.archive).toHaveBeenCalledWith(['Projects/DFAI.md']);
  });

  it('offers Unarchive for a project archived by its value, through the Unarchive command', () => {
    const { menu, commands } = items({
      path: 'Projects/DFAI.md',
      properties: { type: 'Project', para: 'archive', para_before_archive: 'area' },
    });
    expect(menu.onArchive).toBeUndefined();
    menu.onUnarchive?.();
    expect(commands.unarchive).toHaveBeenCalledWith(['Projects/DFAI.md']);
  });

  it('offers Archive for a PARA note too deep to move: it is archived where it stands', () => {
    const deep = `${Array.from({ length: 32 }, (_, at) => `f${String(at)}`).join('/')}/Deep.md`;
    expect(items({ path: deep, properties: { type: 'task' } }).menu.onArchive).toBeUndefined();
    expect(items({ path: deep, properties: { type: 'project' } }).menu.onArchive).toBeDefined();
  });

  it('archives any other note by moving it, as before', () => {
    const { menu, commands } = items({
      path: 'Tasks/Call the bank.md',
      properties: { type: 'task' },
    });
    menu.onArchive?.();
    expect(commands.archive).toHaveBeenCalledWith(['Tasks/Call the bank.md']);
  });

  it('takes a project already in the Archive folder out through the Unarchive command', () => {
    const { menu, commands } = items({
      path: 'Archive/Projects/DFAI.md',
      properties: { type: 'project', para: 'archive' },
    });
    menu.onUnarchive?.();
    expect(commands.unarchive).toHaveBeenCalledWith(['Archive/Projects/DFAI.md']);
  });

  it('never offers a project template Archive or Unarchive', () => {
    for (const para of ['project', 'archive']) {
      const { menu } = items({
        path: '.atlas/templates/Project.md',
        properties: { type: 'project', para },
      });
      expect(menu).toEqual({});
    }
  });

  it('offers no Archive while the note is still opening: a project must not be moved', () => {
    expect(items({ path: 'Projects/DFAI.md', properties: null }).menu).toEqual({});
  });

  it('offers nothing while the Archive is busy, or with no note', () => {
    expect(items({ path: 'Projects/DFAI.md', properties: {}, busy: true }).menu).toEqual({});
    expect(items({ path: null, properties: null }).menu).toEqual({});
  });
});
