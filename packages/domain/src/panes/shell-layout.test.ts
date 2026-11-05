import { describe, expect, it } from 'vitest';
import {
  COMPACT_BELOW,
  NOTE_MEASURE,
  PHONE_BELOW,
  PHONE_SCREENS,
  phoneScreenShowing,
  phoneScreenTarget,
  SIDEBAR_WIDTH,
  shellLayoutFor,
} from './shell-layout.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { MAX_PANES } from './workspace.ts';

const WIDE = { sidebar: 'beside', panes: MAX_PANES, screens: null };
const COMPACT = { sidebar: 'drawer', panes: 1, screens: null };
const PHONE = { sidebar: 'drawer', panes: 1, screens: ['quick-add', 'today', 'notes'] };

describe('shellLayoutFor', () => {
  it('keeps the sidebar beside the work, with room to split, from the breakpoint up', () => {
    expect(shellLayoutFor(COMPACT_BELOW)).toEqual(WIDE);
    expect(shellLayoutFor(1180)).toEqual(WIDE);
    expect(shellLayoutFor(1440)).toEqual(WIDE);
  });

  it('makes the sidebar a drawer and shows one pane one pixel under it', () => {
    expect(shellLayoutFor(COMPACT_BELOW - 1)).toEqual(COMPACT);
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

  it('adds the bar of screens under the phone edge, and one pixel under it only', () => {
    expect(shellLayoutFor(PHONE_BELOW - 1)).toEqual(PHONE);
    expect(shellLayoutFor(PHONE_BELOW)).toEqual(COMPACT);
    expect(PHONE_BELOW).toBe(600);
  });

  it('gives a phone held upright the screens quick add, Today and Notes, in that order', () => {
    expect(shellLayoutFor(390).screens).toEqual(['quick-add', 'today', 'notes']);
    expect(shellLayoutFor(430).screens).toBe(PHONE_SCREENS);
    expect(shellLayoutFor(480)).toEqual(PHONE);
  });

  it('gives no bar to a tablet or a phone on its side: the drawer is the way about there', () => {
    expect(shellLayoutFor(744).screens).toBeNull();
    expect(shellLayoutFor(820).screens).toBeNull();
    expect(shellLayoutFor(844)).toEqual(COMPACT);
    expect(shellLayoutFor(1180).screens).toBeNull();
    expect(shellLayoutFor(1440).screens).toBeNull();
  });

  it('hands back the same object for widths on the same side of each breakpoint', () => {
    expect(shellLayoutFor(1000)).toBe(shellLayoutFor(1440));
    expect(shellLayoutFor(600)).toBe(shellLayoutFor(820));
    expect(shellLayoutFor(390)).toBe(shellLayoutFor(599));
    expect(shellLayoutFor(390)).not.toBe(shellLayoutFor(820));
    expect(shellLayoutFor(820)).not.toBe(shellLayoutFor(1440));
  });

  it('is frozen: nothing drawn from it can change the rule for the next draw', () => {
    expect(Object.isFrozen(shellLayoutFor(390))).toBe(true);
    expect(Object.isFrozen(shellLayoutFor(820))).toBe(true);
    expect(Object.isFrozen(shellLayoutFor(1440))).toBe(true);
  });
});

describe('phoneScreenTarget', () => {
  it('opens quick add as the capture palette and Notes as the search, whatever the vault holds', () => {
    for (const tasksShown of [true, false]) {
      expect(phoneScreenTarget('quick-add', { tasksShown })).toEqual({ open: 'capture' });
      expect(phoneScreenTarget('notes', { tasksShown })).toEqual({ open: 'search' });
    }
  });

  it('opens Today as the Today page once the vault has tasks', () => {
    expect(phoneScreenTarget('today', { tasksShown: true })).toEqual({ open: 'today-page' });
  });

  it("opens Today as today's note until then: the one thing of today's every vault has", () => {
    expect(phoneScreenTarget('today', { tasksShown: false })).toEqual({ open: 'daily-note' });
  });
});

describe('phoneScreenShowing', () => {
  const dailyNote = createVaultPath('2026-10-13.md');
  const other = createVaultPath('Garden plan.md');

  it('is Today while the pane shows the Today page, in a vault with tasks', () => {
    expect(phoneScreenShowing({ kind: 'today' }, { tasksShown: true, dailyNote })).toBe('today');
    expect(phoneScreenShowing({ kind: 'inbox' }, { tasksShown: true, dailyNote })).toBeNull();
    expect(
      phoneScreenShowing({ kind: 'note', path: dailyNote }, { tasksShown: true, dailyNote }),
    ).toBeNull();
  });

  it("is Today while the pane shows today's note, in a vault without tasks", () => {
    expect(
      phoneScreenShowing({ kind: 'note', path: dailyNote }, { tasksShown: false, dailyNote }),
    ).toBe('today');
    expect(
      phoneScreenShowing({ kind: 'note', path: other }, { tasksShown: false, dailyNote }),
    ).toBeNull();
    expect(phoneScreenShowing({ kind: 'today' }, { tasksShown: false, dailyNote })).toBeNull();
  });

  it("is nothing while today's note is not known yet, or no pane shows anything", () => {
    expect(
      phoneScreenShowing({ kind: 'note', path: dailyNote }, { tasksShown: false, dailyNote: null }),
    ).toBeNull();
    expect(phoneScreenShowing(null, { tasksShown: false, dailyNote })).toBeNull();
    expect(phoneScreenShowing(null, { tasksShown: true, dailyNote: null })).toBeNull();
  });
});
