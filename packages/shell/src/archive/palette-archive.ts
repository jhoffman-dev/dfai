import { archiveRefusal, isArchivedPath, type PaletteCommand, type VaultPath } from '@dfai/domain';
import type { ArchiveCommands } from './use-archive.ts';

const ARCHIVE_NOTE = 'archive-note';
const UNARCHIVE_NOTE = 'unarchive-note';
const OPEN_ARCHIVE = 'open-archive';

/**
 * What the search palette offers for the Archive: opening it, and archiving —
 * or unarchiving — the note in the focused pane, when there is one it applies to.
 */
export function paletteArchiveCommands(focused: VaultPath | null): PaletteCommand[] {
  const commands: PaletteCommand[] = [
    { id: OPEN_ARCHIVE, label: 'Open Archive', keywords: ['archived', 'put away'] },
  ];
  if (focused === null) return commands;
  if (isArchivedPath(focused)) {
    commands.unshift({ id: UNARCHIVE_NOTE, label: 'Unarchive this note', keywords: ['restore'] });
  } else if (archiveRefusal(focused) === null) {
    commands.unshift({ id: ARCHIVE_NOTE, label: 'Archive this note', keywords: ['put away'] });
  }
  return commands;
}

/** Runs one of those commands; false when `id` is not one of them. */
export function runPaletteArchiveCommand(
  id: string,
  {
    focused,
    commands,
    openArchive,
  }: { focused: VaultPath | null; commands: ArchiveCommands; openArchive: () => void },
): boolean {
  if (id === OPEN_ARCHIVE) {
    openArchive();
    return true;
  }
  if (focused === null) return false;
  // What a batch could not do is shown as the window's notice, not here.
  if (id === ARCHIVE_NOTE) void commands.archive([focused]);
  else if (id === UNARCHIVE_NOTE) void commands.unarchive([focused]);
  else return false;
  return true;
}
