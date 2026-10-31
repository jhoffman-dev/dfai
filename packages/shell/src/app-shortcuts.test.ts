// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { runsOnMac, useAppShortcuts, type AppShortcuts } from './app-shortcuts.ts';
import { createVaultPath } from '@dfai/domain';
import type { Overlay } from './overlay.ts';

function listen(overlay: Overlay | null = null, onMac = true): AppShortcuts {
  return listenTo(() => ({ overlay, peek: null }), onMac);
}

/** The shortcuts, reading what is up from `layers` at each key press. */
function listenTo(layers: AppShortcuts['layers'], onMac = true): AppShortcuts {
  const shortcuts: AppShortcuts = {
    layers,
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
  renderHook(() => useAppShortcuts(shortcuts, { onMac }));
  return shortcuts;
}

const press = (init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, altKey: true, ...init }));

describe('Alt+Cmd+N, kept from the retired add button: it opens capture (Q5)', () => {
  it('is found by the key in N’s place, where Alt turns it into a dead key', () => {
    const shortcuts = listen();
    press({ key: 'Dead', code: 'KeyN' });
    expect(shortcuts.capture).toHaveBeenCalledTimes(1);
    expect(shortcuts.newNote).not.toHaveBeenCalled();
  });

  it('is found by the letter N on a layout that puts it elsewhere, as Dvorak does', () => {
    const shortcuts = listen();
    press({ key: 'n', code: 'KeyL' });
    expect(shortcuts.capture).toHaveBeenCalledTimes(1);
    expect(shortcuts.newNote).not.toHaveBeenCalled();
  });

  it('opens capture once for Shift+Alt+Cmd+N, which is Shift+Cmd+N as well', () => {
    const shortcuts = listen();
    press({ key: 'N', code: 'KeyN', shiftKey: true });
    expect(shortcuts.capture).toHaveBeenCalledTimes(1);
    expect(shortcuts.show).not.toHaveBeenCalled();
  });

  it('is not Alt+Cmd with another letter', () => {
    const shortcuts = listen();
    press({ key: 'b', code: 'KeyB' });
    expect(shortcuts.capture).not.toHaveBeenCalled();
  });
});

describe('Shift+Cmd+N, capture', () => {
  it('asks for capture rather than showing it, so the app can say a vault is needed', () => {
    const shortcuts = listen();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { metaKey: true, shiftKey: true, key: 'N', code: 'KeyN' }),
    );
    expect(shortcuts.capture).toHaveBeenCalledTimes(1);
    expect(shortcuts.show).not.toHaveBeenCalled();
  });
});

describe('a shortcut that makes a note, pressed behind an open palette (A14-08)', () => {
  const chord = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, ...init }));

  it.each(['search', 'capture', 'settings'] as const)('does nothing while %s is up', (overlay) => {
    const shortcuts = listen(overlay);
    chord({ key: 'n', code: 'KeyN' });
    chord({ key: 'D', code: 'KeyD', shiftKey: true });
    chord({ key: 'Dead', code: 'KeyN', altKey: true });
    expect(shortcuts.newNote).not.toHaveBeenCalled();
    expect(shortcuts.dailyNote).not.toHaveBeenCalled();
    expect(shortcuts.capture).not.toHaveBeenCalled();
  });

  it('does nothing behind a palette opened since the window last drew (#261)', () => {
    let up: Overlay | null = null;
    const shortcuts = listenTo(() => ({ overlay: up, peek: null }));
    // ⌘K opens from the store; the window is not drawn again to hand it over.
    up = 'search';
    chord({ key: 'n', code: 'KeyN' });
    expect(shortcuts.newNote).not.toHaveBeenCalled();
  });

  it('still acts with only a menu up, which gives way to it (control)', () => {
    const shortcuts = listen('new-note-menu');
    chord({ key: 'n', code: 'KeyN' });
    chord({ key: 'D', code: 'KeyD', shiftKey: true });
    chord({ key: 'Dead', code: 'KeyN', altKey: true });
    expect(shortcuts.newNote).toHaveBeenCalledTimes(1);
    expect(shortcuts.dailyNote).toHaveBeenCalledTimes(1);
    expect(shortcuts.capture).toHaveBeenCalledTimes(1);
  });
});

describe('the shortcuts behind the peek (slice 6b, Q6)', () => {
  const chord = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, ...init }));
  const PEEK = { path: createVaultPath('Tasks/a.md'), from: null };

  it('holds the ones that make, open or arrange notes while a note is peeked', () => {
    const shortcuts = listenTo(() => ({ overlay: null, peek: PEEK }));
    chord({ key: 'n', code: 'KeyN' });
    chord({ key: 'D', code: 'KeyD', shiftKey: true });
    chord({ key: '|', shiftKey: true });
    chord({ key: '[' });
    chord({ key: 't' });
    expect(shortcuts.newNote).not.toHaveBeenCalled();
    expect(shortcuts.dailyNote).not.toHaveBeenCalled();
    expect(shortcuts.toggleSplit).not.toHaveBeenCalled();
    expect(shortcuts.back).not.toHaveBeenCalled();
    expect(shortcuts.tabs.newTab).not.toHaveBeenCalled();
  });

  it('still opens search over it and saves, and closes no tab under it with ⌘W', () => {
    const shortcuts = listenTo(() => ({ overlay: null, peek: PEEK }));
    chord({ key: 'k' });
    chord({ key: 's' });
    chord({ key: 'w' });
    expect(shortcuts.show).toHaveBeenCalledWith('search');
    expect(shortcuts.save).toHaveBeenCalledTimes(1);
    expect(shortcuts.tabs.closeTab).not.toHaveBeenCalled();
  });
});

describe('Cmd+J, Ask, and Shift+Cmd+J, Claude beside the work (#37)', () => {
  const cmd = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, ...init }));

  it('opens Ask, and not the sidebar chat', () => {
    const shortcuts = listen();
    cmd({ key: 'j' });
    expect(shortcuts.ask).toHaveBeenCalledTimes(1);
    expect(shortcuts.toggleChat).not.toHaveBeenCalled();
  });

  it('opens and closes the sidebar chat with Shift, and not Ask', () => {
    const shortcuts = listen();
    cmd({ key: 'J', shiftKey: true });
    expect(shortcuts.toggleChat).toHaveBeenCalledTimes(1);
    expect(shortcuts.ask).not.toHaveBeenCalled();
  });

  it('is left alone while a dialog holds the screen, or with Alt held', () => {
    const shortcuts = listen('settings');
    cmd({ key: 'j' });
    cmd({ key: 'J', shiftKey: true });
    expect(shortcuts.ask).not.toHaveBeenCalled();
    expect(shortcuts.toggleChat).not.toHaveBeenCalled();
    const free = listen();
    cmd({ key: 'j', altKey: true });
    expect(free.ask).not.toHaveBeenCalled();
    expect(free.toggleChat).not.toHaveBeenCalled();
  });
});

describe('the shortcuts that change the window, behind a dialog (#266)', () => {
  const chord = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, ...init }));
  const mouseButton = (button: number) =>
    window.dispatchEvent(new MouseEvent('mouseup', { button }));

  /** Every window-changing key, and the mouse's back and forward buttons. */
  function pressAll(): void {
    chord({ key: '[' });
    chord({ key: ']' });
    chord({ key: '\\' });
    chord({ key: '|', shiftKey: true });
    mouseButton(3);
    mouseButton(4);
  }

  it.each(['search', 'capture', 'settings'] as const)('do nothing while %s is up', (overlay) => {
    const shortcuts = listen(overlay);
    pressAll();
    expect(shortcuts.back).not.toHaveBeenCalled();
    expect(shortcuts.forward).not.toHaveBeenCalled();
    expect(shortcuts.toggleSidebar).not.toHaveBeenCalled();
    expect(shortcuts.toggleSplit).not.toHaveBeenCalled();
  });

  it('act with nothing up, or only a menu (control)', () => {
    for (const overlay of [null, 'new-note-menu'] as const) {
      const shortcuts = listen(overlay);
      pressAll();
      expect(shortcuts.back).toHaveBeenCalledTimes(2);
      expect(shortcuts.forward).toHaveBeenCalledTimes(2);
      expect(shortcuts.toggleSidebar).toHaveBeenCalledTimes(1);
      expect(shortcuts.toggleSplit).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the tab shortcuts (tab-model.md)', () => {
  const chord = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { cancelable: true, ...init });
    window.dispatchEvent(event);
    return event;
  };

  it('opens a tab with ⌘T, reopens the last closed with ⌘⇧T, and closes with ⌘W', () => {
    const { tabs } = listen();
    chord({ metaKey: true, key: 't' });
    expect(tabs.newTab).toHaveBeenCalledTimes(1);
    chord({ metaKey: true, shiftKey: true, key: 'T' });
    expect(tabs.reopenClosedTab).toHaveBeenCalledTimes(1);
    expect(tabs.newTab).toHaveBeenCalledTimes(1);
    const close = chord({ metaKey: true, key: 'w' });
    expect(tabs.closeTab).toHaveBeenCalledTimes(1);
    // Never left to the host, which would close the window.
    expect(close.defaultPrevented).toBe(true);
  });

  it('walks the tabs with ⌃Tab and ⌃⇧Tab, and numbers them with ⌘1–9', () => {
    const { tabs } = listen();
    chord({ ctrlKey: true, key: 'Tab' });
    expect(tabs.nextTab).toHaveBeenCalledTimes(1);
    chord({ ctrlKey: true, shiftKey: true, key: 'Tab' });
    expect(tabs.previousTab).toHaveBeenCalledTimes(1);
    chord({ metaKey: true, key: '3' });
    chord({ metaKey: true, key: '9' });
    expect(vi.mocked(tabs.nthTab).mock.calls).toEqual([[3], [9]]);
    chord({ metaKey: true, key: '0' });
    chord({ metaKey: true, shiftKey: true, key: '3' });
    expect(tabs.nthTab).toHaveBeenCalledTimes(2);
  });

  it('keeps ⌘W from the host behind a dialog too, closing no tab there', () => {
    const { tabs } = listen('settings');
    const close = chord({ metaKey: true, key: 'w' });
    expect(close.defaultPrevented).toBe(true);
    expect(tabs.closeTab).not.toHaveBeenCalled();
    chord({ metaKey: true, key: 't' });
    chord({ ctrlKey: true, key: 'Tab' });
    chord({ metaKey: true, key: '2' });
    expect(tabs.newTab).not.toHaveBeenCalled();
    expect(tabs.nextTab).not.toHaveBeenCalled();
    expect(tabs.nthTab).not.toHaveBeenCalled();
  });

  it('leaves Tab alone without Ctrl, and ⌘T alone with Alt', () => {
    const { tabs } = listen();
    chord({ key: 'Tab' });
    chord({ metaKey: true, altKey: true, key: 't' });
    expect(tabs.nextTab).not.toHaveBeenCalled();
    expect(tabs.newTab).not.toHaveBeenCalled();
  });

  it('leaves ⌃T, ⌃W and ⌃1 to the Mac’s text system, and takes them as Ctrl off a Mac', () => {
    const mac = listen();
    const transpose = chord({ ctrlKey: true, key: 't' });
    chord({ ctrlKey: true, key: 'w' });
    chord({ ctrlKey: true, key: '1' });
    expect(mac.tabs.newTab).not.toHaveBeenCalled();
    expect(mac.tabs.closeTab).not.toHaveBeenCalled();
    expect(mac.tabs.nthTab).not.toHaveBeenCalled();
    expect(transpose.defaultPrevented).toBe(false);

    const other = listen(null, false);
    chord({ ctrlKey: true, key: 't' });
    chord({ ctrlKey: true, key: 'w' });
    chord({ ctrlKey: true, key: '2' });
    chord({ metaKey: true, key: 't' });
    expect(other.tabs.newTab).toHaveBeenCalledTimes(1);
    expect(other.tabs.closeTab).toHaveBeenCalledTimes(1);
    expect(other.tabs.nthTab).toHaveBeenCalledWith(2);
  });

  it('reads the platform string for a Mac', () => {
    expect(runsOnMac('MacIntel')).toBe(true);
    expect(runsOnMac('Win32')).toBe(false);
    expect(runsOnMac('Linux x86_64')).toBe(false);
  });
});

describe('Alt+Cmd+\\, the right sidebar (UI v2 slice 8b)', () => {
  const chord = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, ...init }));

  it('is found by the key in the backslash’s place, where Alt turns it into «', () => {
    const shortcuts = listen();
    chord({ altKey: true, key: '«', code: 'Backslash' });
    expect(shortcuts.toggleAside).toHaveBeenCalledTimes(1);
    expect(shortcuts.toggleSidebar).not.toHaveBeenCalled();
    expect(shortcuts.toggleSplit).not.toHaveBeenCalled();
  });

  it('is found by the backslash itself on a layout that leaves it alone', () => {
    const shortcuts = listen();
    chord({ altKey: true, key: '\\', code: 'IntlBackslash' });
    expect(shortcuts.toggleAside).toHaveBeenCalledTimes(1);
    expect(shortcuts.toggleSidebar).not.toHaveBeenCalled();
  });

  it('leaves Cmd+\\ to the left sidebar and Shift+Cmd+\\ to the split', () => {
    const shortcuts = listen();
    chord({ key: '\\', code: 'Backslash' });
    chord({ shiftKey: true, key: '|', code: 'Backslash' });
    expect(shortcuts.toggleAside).not.toHaveBeenCalled();
    expect(shortcuts.toggleSidebar).toHaveBeenCalledTimes(1);
    expect(shortcuts.toggleSplit).toHaveBeenCalledTimes(1);
  });

  it('does nothing behind a dialog, as the other window-changing keys do', () => {
    const shortcuts = listen('settings');
    chord({ altKey: true, key: '«', code: 'Backslash' });
    expect(shortcuts.toggleAside).not.toHaveBeenCalled();
  });
});
