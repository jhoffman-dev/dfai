import { describe, expect, it, vi } from 'vitest';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import type { MenuCommand } from '@dfai/ui';
import { archiveCommand, withCommandBeforeDelete } from './archive-menu.ts';
import { paletteArchiveCommands, runPaletteArchiveCommand } from './palette-archive.ts';
import type { ArchiveCommands } from './use-archive.ts';

const path = (raw: string): VaultPath => createVaultPath(raw);
const commands = (busy = false): ArchiveCommands => ({
  archive: vi.fn(),
  unarchive: vi.fn(),
  busy,
});
const NOTES = ['Projects/a.md', 'Projects/Sub/b.md', 'Archive/Projects/c.md', 'Other.md'].map(path);

describe('archiveCommand', () => {
  it('archives a note from its row', () => {
    const run = commands();
    const item = archiveCommand({
      entry: { path: path('Other.md'), kind: 'file' },
      notePaths: NOTES,
      commands: run,
    });
    expect(item.label).toBe('Archive');
    item.onSelect();
    expect(run.archive).toHaveBeenCalledWith(['Other.md']);
  });

  it('archives every note in a folder, saying how many', () => {
    const run = commands();
    const item = archiveCommand({
      entry: { path: path('Projects'), kind: 'directory' },
      notePaths: NOTES,
      commands: run,
    });
    expect(item.label).toBe('Archive 2 notes');
    item.onSelect();
    expect(run.archive).toHaveBeenCalledWith(['Projects/a.md', 'Projects/Sub/b.md']);
  });

  it('is disabled for a folder with no notes, and while a batch runs', () => {
    expect(
      archiveCommand({
        entry: { path: path('Empty'), kind: 'directory' },
        notePaths: NOTES,
        commands: commands(),
      }).disabled,
    ).toBe(true);
    expect(
      archiveCommand({
        entry: { path: path('Other.md'), kind: 'file' },
        notePaths: NOTES,
        commands: commands(true),
      }).disabled,
    ).toBe(true);
  });

  it('unarchives an archived note', () => {
    const run = commands();
    const item = archiveCommand({
      entry: { path: path('Archive/Projects/c.md'), kind: 'file' },
      notePaths: NOTES,
      commands: run,
    });
    expect(item.label).toBe('Unarchive');
    item.onSelect();
    expect(run.unarchive).toHaveBeenCalledWith(['Archive/Projects/c.md']);
  });
});

describe('withCommandBeforeDelete', () => {
  const item = (label: string, destructive = false): MenuCommand => ({
    label,
    onSelect: () => {},
    ...(destructive && { destructive }),
  });

  it('puts the command just before the destructive items', () => {
    const menu = withCommandBeforeDelete([item('Rename'), item('Delete…', true)], item('Archive'));
    expect(menu.map((each) => each.label)).toEqual(['Rename', 'Archive', 'Delete…']);
  });

  it('puts it last when nothing is destructive', () => {
    expect(
      withCommandBeforeDelete([item('Rename')], item('Archive')).map((each) => each.label),
    ).toEqual(['Rename', 'Archive']);
  });
});

describe('the palette’s Archive commands', () => {
  const labels = (focused: string | null) =>
    paletteArchiveCommands(focused === null ? null : path(focused)).map((command) => command.label);

  it('offers archiving the focused note, or unarchiving it, and always opening the Archive', () => {
    expect(labels('Notes/a.md')).toEqual(['Archive this note', 'Open Archive']);
    expect(labels('Archive/Notes/a.md')).toEqual(['Unarchive this note', 'Open Archive']);
    expect(labels('.atlas/views/Board.md')).toEqual(['Open Archive']);
    expect(labels(null)).toEqual(['Open Archive']);
  });

  it('runs them, and leaves any other command alone', () => {
    const run = commands();
    const openArchive = vi.fn();
    const focused = path('Notes/a.md');
    expect(runPaletteArchiveCommand('archive-note', { focused, commands: run, openArchive })).toBe(
      true,
    );
    expect(
      runPaletteArchiveCommand('unarchive-note', { focused, commands: run, openArchive }),
    ).toBe(true);
    expect(
      runPaletteArchiveCommand('open-archive', { focused: null, commands: run, openArchive }),
    ).toBe(true);
    expect(runPaletteArchiveCommand('new-view', { focused, commands: run, openArchive })).toBe(
      false,
    );
    expect(
      runPaletteArchiveCommand('archive-note', { focused: null, commands: run, openArchive }),
    ).toBe(false);
    expect(run.archive).toHaveBeenCalledWith(['Notes/a.md']);
    expect(run.unarchive).toHaveBeenCalledWith(['Notes/a.md']);
    expect(openArchive).toHaveBeenCalledTimes(1);
  });
});
