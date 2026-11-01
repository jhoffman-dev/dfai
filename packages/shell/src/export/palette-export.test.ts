import { describe, expect, it, vi } from 'vitest';
import type { VaultPath } from '@dfai/domain';
import { paletteExportCommands, runPaletteExportCommand } from './palette-export.ts';

const NOTE = 'Kickoff.md' as VaultPath;

describe('⌘K Export… (#501)', () => {
  it('is offered for the note on screen, and not without one', () => {
    expect(paletteExportCommands(NOTE).map((command) => command.label)).toEqual(['Export…']);
    expect(paletteExportCommands(null)).toEqual([]);
  });

  it('asks how to export that note, and answers only its own command', () => {
    const commands = { ask: vi.fn(), run: vi.fn(), close: vi.fn() };
    const [command] = paletteExportCommands(NOTE);
    expect(runPaletteExportCommand(command!.id, { focused: NOTE, commands })).toBe(true);
    expect(commands.ask).toHaveBeenCalledWith([NOTE]);
    expect(runPaletteExportCommand('archive-note', { focused: NOTE, commands })).toBe(false);
    expect(runPaletteExportCommand(command!.id, { focused: null, commands })).toBe(false);
    expect(commands.ask).toHaveBeenCalledTimes(1);
  });
});
