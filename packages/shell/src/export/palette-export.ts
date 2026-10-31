import type { PaletteCommand, VaultPath } from '@dfai/domain';
import type { ExportCommands } from './export-flow.ts';

const EXPORT_NOTE = 'export-note';

/** ⌘K's "Export…" for the note in the focused pane (#501), when there is one. */
export function paletteExportCommands(focused: VaultPath | null): PaletteCommand[] {
  if (focused === null) return [];
  return [
    {
      id: EXPORT_NOTE,
      label: 'Export…',
      keywords: ['markdown', 'pdf', 'google doc', 'download', 'save as', 'share'],
    },
  ];
}

/** Runs it; false when `id` is not it. */
export function runPaletteExportCommand(
  id: string,
  { focused, commands }: { focused: VaultPath | null; commands: ExportCommands },
): boolean {
  if (id !== EXPORT_NOTE || focused === null) return false;
  commands.ask([focused]);
  return true;
}
