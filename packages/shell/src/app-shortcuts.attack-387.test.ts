// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useAppShortcuts, type AppShortcuts } from './app-shortcuts.ts';
import type { Overlay } from './overlay.ts';

// Attack pass on PR #387: Alt+Cmd+\ and Cmd+J against what holds the screen.

afterEach(cleanup);

function listen(overlay: Overlay | null = null): AppShortcuts {
  const shortcuts: AppShortcuts = {
    layers: () => ({ overlay, peek: null }),
    save: vi.fn(),
    newNote: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleSplit: vi.fn(),
    dailyNote: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    show: vi.fn(),
    capture: vi.fn(),
    ask: vi.fn(),
    toggleChat: vi.fn(),
    toggleAside: vi.fn(),
    tabs: {
      newTab: vi.fn(),
      closeTab: vi.fn(),
      nextTab: vi.fn(),
      previousTab: vi.fn(),
      nthTab: vi.fn(),
      reopenClosedTab: vi.fn(),
    },
  };
  renderHook(() => useAppShortcuts(shortcuts, { onMac: true }));
  return shortcuts;
}

const asideChord = () =>
  window.dispatchEvent(
    new KeyboardEvent('keydown', { metaKey: true, altKey: true, key: '«', code: 'Backslash' }),
  );

describe('Alt+Cmd+\\ and Cmd+J behind what holds the screen (attack #387)', () => {
  it.each<Overlay>(['search', 'capture', 'move-picker'])(
    'guard: Alt+Cmd+\\ does nothing while %s is up',
    (overlay) => {
      const shortcuts = listen(overlay);
      asideChord();
      expect(shortcuts.toggleAside).not.toHaveBeenCalled();
      expect(shortcuts.toggleSidebar).not.toHaveBeenCalled();
    },
  );

  it('guard: Alt+Cmd+\\ still works while only a pane’s menu is up (a menu is not modal)', () => {
    const shortcuts = listen('page-menu-0');
    asideChord();
    expect(shortcuts.toggleAside).toHaveBeenCalledTimes(1);
  });

  it('guard: Alt+Cmd+\\ is the right sidebar’s once and never also the left’s or the split’s', () => {
    const shortcuts = listen();
    asideChord();
    asideChord();
    expect(shortcuts.toggleAside).toHaveBeenCalledTimes(2);
    expect(shortcuts.toggleSidebar).not.toHaveBeenCalled();
    expect(shortcuts.toggleSplit).not.toHaveBeenCalled();
    expect(shortcuts.toggleChat).not.toHaveBeenCalled();
  });

  it('guard: Cmd+J does nothing behind the ⌘K palette', () => {
    const shortcuts = listen('search');
    window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, key: 'j', code: 'KeyJ' }));
    expect(shortcuts.ask).not.toHaveBeenCalled();
    expect(shortcuts.toggleChat).not.toHaveBeenCalled();
  });
});
