import {
  archiveRefusal,
  archivesWhereItStands,
  isArchivedPath,
  isAtlasNote,
  isParaArchived,
  notesUnder,
  type MovableEntry,
  type VaultPath,
} from '@dfai/domain';
import type { MenuCommand } from '@dfai/ui';
import type { ArchiveCommands } from './use-archive.ts';

/**
 * The notes archiving `entry` would put away: the note itself, or every note
 * under the folder — the ones that can be archived.
 */
export function archivableNotes(entry: MovableEntry, notePaths: readonly VaultPath[]): VaultPath[] {
  return notesUnder(entry, notePaths).filter((path) => archiveRefusal(path) === null);
}

/**
 * A Pages row's "Archive" (or, for an archived note, "Unarchive"), for its menu.
 *
 * A folder archives every note in it, each to its own path under `Archive/`;
 * the folder and any files that are not notes stay where they are.
 */
export function archiveCommand({
  entry,
  notePaths,
  commands,
}: {
  entry: MovableEntry;
  notePaths: readonly VaultPath[];
  commands: ArchiveCommands;
}): MenuCommand {
  if (entry.kind === 'file' && isArchivedPath(entry.path)) {
    return {
      label: 'Unarchive',
      onSelect: () => commands.unarchive([entry.path]),
      disabled: commands.busy,
    };
  }
  const notes = archivableNotes(entry, notePaths);
  return {
    label: entry.kind === 'directory' ? `Archive ${countNotes(notes.length)}` : 'Archive',
    onSelect: () => commands.archive(notes),
    disabled: commands.busy || notes.length === 0,
  };
}

const countNotes = (n: number) => (n === 1 ? '1 note' : `${n} notes`);

/** A menu with `command` added just before its destructive items, or at its end. */
export function withCommandBeforeDelete(
  items: readonly MenuCommand[],
  command: MenuCommand,
): MenuCommand[] {
  const at = items.findIndex((item) => item.destructive === true);
  if (at === -1) return [...items, command];
  return [...items.slice(0, at), command, ...items.slice(at)];
}

/**
 * "Archive" for a note that can be archived, "Unarchive" for one that is —
 * in the Archive folder, or a Project archived by its value where it stands
 * (#213). Either goes through the same commands as every other way of
 * archiving: a PARA note is archived by its `para` and the file stays; every
 * other note is moved.
 */
export function pageArchiveItems({
  commands,
  path,
  properties,
}: {
  commands: ArchiveCommands;
  path: VaultPath | null;
  /** The note's frontmatter as the pane holds it, or null while it opens. */
  properties: Readonly<Record<string, unknown>> | null;
}): { onArchive?: () => void; onUnarchive?: () => void } {
  if (path === null || commands.busy) return {};
  const unarchive = { onUnarchive: () => void commands.unarchive([path]) };
  if (isArchivedPath(path)) return unarchive;
  // Until the note is read, whether it is PARA's — archived where it stands — is not known.
  if (properties === null) return {};
  const para = !isAtlasNote(path);
  if (para && isParaArchived(properties)) return unarchive;
  const archivable = archiveRefusal(path) === null || (para && archivesWhereItStands(properties));
  return archivable ? { onArchive: () => void commands.archive([path]) } : {};
}
