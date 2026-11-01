import { describe, expect, it, vi } from 'vitest';
import { paletteKindleCommands, runPaletteKindleCommand } from './palette-kindle.ts';

describe('paletteKindleCommands', () => {
  it('offers Connect Kindle until it is connected, then Sync now and Disconnect', () => {
    expect(paletteKindleCommands(false).map((c) => c.label)).toEqual(['Connect Kindle']);
    expect(paletteKindleCommands(true).map((c) => c.label)).toEqual([
      'Sync Kindle now',
      'Disconnect Kindle',
    ]);
  });

  it('runs the command picked, and nothing for an id that is not one of them', () => {
    const commands = { connect: vi.fn(), syncNow: vi.fn(), disconnect: vi.fn() };
    const [connect] = paletteKindleCommands(false);
    const [syncNow, disconnect] = paletteKindleCommands(true);
    expect(runPaletteKindleCommand(connect?.id ?? '', commands)).toBe(true);
    expect(runPaletteKindleCommand(syncNow?.id ?? '', commands)).toBe(true);
    expect(runPaletteKindleCommand(disconnect?.id ?? '', commands)).toBe(true);
    expect(runPaletteKindleCommand('new-query', commands)).toBe(false);
    expect(commands.connect).toHaveBeenCalledOnce();
    expect(commands.syncNow).toHaveBeenCalledOnce();
    expect(commands.disconnect).toHaveBeenCalledOnce();
  });
});
