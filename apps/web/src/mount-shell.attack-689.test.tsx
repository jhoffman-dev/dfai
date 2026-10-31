// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { mountShell } from '@dfai/shell';
import { composeWeb } from './composition.ts';

/*
 * Attack on PR #689 (#656): mountShell's lifecycle, on the web's real ports.
 * One page holds one shell; taking it down leaves nothing of it behind.
 */

beforeAll(() => vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel'));

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  vi.restoreAllMocks();
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  document.body.innerHTML = '';
  window.localStorage.clear();
});

const DRAG_EVENTS = ['dragover', 'drop', 'dragenter', 'dragleave', 'dragend'];

/** The drag listeners on `window` added and not yet removed, by watching both calls. */
function watchDragListeners(): () => number {
  let live = 0;
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, ...rest) => {
    if (DRAG_EVENTS.includes(type)) live += 1;
    add(type, ...rest);
  });
  vi.spyOn(window, 'removeEventListener').mockImplementation((type, ...rest) => {
    if (DRAG_EVENTS.includes(type)) live -= 1;
    remove(type, ...rest);
  });
  return () => live;
}

describe('mountShell on one page (attack #689)', () => {
  it('leaves no drag guard behind after unmount, then remount', { timeout: 30_000 }, async () => {
    const live = watchDragListeners();
    document.body.innerHTML = '<div id="root"></div>';
    const first = mountShell({ ports: composeWeb() });
    await screen.findByRole('treeitem', { name: 'Welcome' }, { timeout: 10_000 });
    const oneShell = live();
    first();
    expect(live()).toBe(0);
    unmounts.push(mountShell({ ports: composeWeb() }));
    await screen.findByRole('treeitem', { name: 'Welcome' }, { timeout: 10_000 });
    expect(live()).toBe(oneShell);
  });

  it('refuses a second shell on a page that already holds one', () => {
    document.body.innerHTML = '<div id="root"></div>';
    unmounts.push(mountShell({ ports: composeWeb() }));
    // A second call would put two Apps on one #root and two drag guards on the window.
    expect(() => unmounts.push(mountShell({ ports: composeWeb() }))).toThrow();
  });
});
