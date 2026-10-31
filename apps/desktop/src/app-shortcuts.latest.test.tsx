// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { useLayoutEffect } from 'react';
import { render } from '@testing-library/react';
import { useAppShortcuts, type AppShortcuts } from './app-shortcuts.ts';

function shortcuts(): AppShortcuts {
  return {
    layers: () => ({ overlay: null, peek: null }),
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
}

function Host({ handlers }: { handlers: AppShortcuts }) {
  useAppShortcuts(handlers, { onMac: true });
  return null;
}

/**
 * Presses ⇧⌘N from its layout effect: after the host's in the same commit, and
 * before any passive effect runs, so the key lands in the gap a passive
 * update of the handlers would leave.
 */
function PressInTheCommit({ at }: { at: number }) {
  useLayoutEffect(() => {
    if (at === 0) return;
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'N', code: 'KeyN', metaKey: true, shiftKey: true }),
    );
  }, [at]);
  return null;
}

describe('useAppShortcuts — the handlers a key reaches', () => {
  it('are the ones the render now committing handed in, before its passive effects run', () => {
    const first = shortcuts();
    const next = shortcuts();
    const view = render(
      <>
        <Host handlers={first} />
        <PressInTheCommit at={0} />
      </>,
    );
    view.rerender(
      <>
        <Host handlers={next} />
        <PressInTheCommit at={1} />
      </>,
    );
    expect(next.capture).toHaveBeenCalledTimes(1);
    expect(first.capture).not.toHaveBeenCalled();
  });
});
