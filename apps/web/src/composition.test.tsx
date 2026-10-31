// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { mountShell } from '@dfai/shell';
import { composeWeb } from './composition.ts';

/*
 * #656: the web build composes the same shell as the desktop, on no host at
 * all. Started as main.ts starts it, the window opens the sample vault and
 * lists its notes, so the seam carries everything the shell needs.
 */

// The shortcuts read the platform; jsdom's is none.
beforeAll(() => vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel'));

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
});

const startedAsMainStartsIt = () => {
  document.body.innerHTML = '<div id="root"></div>';
  unmount = mountShell({ ports: composeWeb() });
};

describe('the web build (#656)', () => {
  it('draws the shell on the sample vault, listing its notes', { timeout: 20_000 }, async () => {
    startedAsMainStartsIt();
    expect(
      await screen.findByRole('treeitem', { name: 'Larkspur garden' }, { timeout: 10_000 }),
    ).toBeDefined();
    expect(screen.getByRole('treeitem', { name: 'Welcome' })).toBeDefined();
  });

  it('takes the window down again when asked', { timeout: 20_000 }, async () => {
    startedAsMainStartsIt();
    await screen.findByRole('treeitem', { name: 'Welcome' }, { timeout: 10_000 });
    unmount?.();
    unmount = null;
    await waitFor(() => expect(document.getElementById('root')?.childElementCount).toBe(0));
  });
});
