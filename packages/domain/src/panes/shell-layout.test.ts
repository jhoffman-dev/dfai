import { describe, expect, it } from 'vitest';
import { COMPACT_BELOW, NOTE_MEASURE, SIDEBAR_WIDTH, shellLayoutFor } from './shell-layout.ts';
import { MAX_PANES } from './workspace.ts';

describe('shellLayoutFor', () => {
  it('keeps the sidebar beside the work, with room to split, from the breakpoint up', () => {
    expect(shellLayoutFor(COMPACT_BELOW)).toEqual({ sidebar: 'beside', panes: MAX_PANES });
    expect(shellLayoutFor(1180)).toEqual({ sidebar: 'beside', panes: MAX_PANES });
    expect(shellLayoutFor(1440)).toEqual({ sidebar: 'beside', panes: MAX_PANES });
  });

  it('makes the sidebar a drawer and shows one pane one pixel under it', () => {
    expect(shellLayoutFor(COMPACT_BELOW - 1)).toEqual({ sidebar: 'drawer', panes: 1 });
  });

  it('is compact on an iPad held upright and on a phone, not on an iPad on its side', () => {
    expect(shellLayoutFor(820).sidebar).toBe('drawer');
    expect(shellLayoutFor(390).sidebar).toBe('drawer');
    expect(shellLayoutFor(1180).sidebar).toBe('beside');
  });

  it('breaks where a note no longer reads at its full measure beside the sidebar', () => {
    expect(COMPACT_BELOW).toBe(SIDEBAR_WIDTH + NOTE_MEASURE);
    expect(COMPACT_BELOW).toBe(944);
  });

  it('hands back the same object for widths on the same side of the breakpoint', () => {
    expect(shellLayoutFor(1000)).toBe(shellLayoutFor(1440));
    expect(shellLayoutFor(390)).toBe(shellLayoutFor(820));
    expect(shellLayoutFor(390)).not.toBe(shellLayoutFor(1440));
  });
});
