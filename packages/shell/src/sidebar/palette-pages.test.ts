// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { palettePagesCommands, runPalettePagesCommand } from './palette-pages.ts';
import { useHiddenSections } from './use-hidden-sections.ts';

const startsHidden = { read: () => ['userSpace' as const], write: () => {} };

describe('the Pages palette commands', () => {
  it('offers only the one that applies', () => {
    expect(palettePagesCommands(false).map((command) => command.label)).toEqual(['Show Pages']);
    expect(palettePagesCommands(true).map((command) => command.label)).toEqual(['Hide Pages']);
  });

  it('carries no "t", which ⌘K’s work budget types', () => {
    for (const command of [...palettePagesCommands(false), ...palettePagesCommands(true)]) {
      expect([command.label, ...(command.keywords ?? [])].join(' ')).not.toMatch(/t/i);
    }
  });

  it('runs each one, and claims no other command', () => {
    const { result } = renderHook(() => useHiddenSections(startsHidden));
    const [show] = palettePagesCommands(false);

    act(() => {
      expect(runPalettePagesCommand(show?.id ?? '', result.current)).toBe(true);
    });
    expect(result.current.isShown('userSpace')).toBe(true);

    const [hide] = palettePagesCommands(true);
    act(() => {
      expect(runPalettePagesCommand(hide?.id ?? '', result.current)).toBe(true);
    });
    expect(result.current.isShown('userSpace')).toBe(false);
    expect(runPalettePagesCommand('new-note', result.current)).toBe(false);
  });
});
