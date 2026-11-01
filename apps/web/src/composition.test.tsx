// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mountShell } from '@dfai/shell';
import { composeWebShell } from './composition.ts';

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
  unmount = mountShell(composeWebShell());
};

describe('the web build (#656)', () => {
  it('draws the shell on the sample vault, listing its notes', { timeout: 20_000 }, async () => {
    startedAsMainStartsIt();
    expect(
      await screen.findByRole('treeitem', { name: 'Larkspur garden' }, { timeout: 10_000 }),
    ).toBeDefined();
    expect(screen.getByRole('treeitem', { name: 'Welcome' })).toBeDefined();
  });

  it(
    'hides what a browser cannot do, from the capabilities it is handed (#657)',
    {
      timeout: 20_000,
    },
    async () => {
      startedAsMainStartsIt();
      await screen.findByRole('treeitem', { name: 'Welcome' }, { timeout: 10_000 });
      // The desktop's sidebar has Ask beside Search, and a sync light by Settings.
      expect(screen.queryByTitle('Ask (⌘J)')).toBeNull();
      expect(screen.queryByLabelText(/^Sync:/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
      const sections = await screen.findByRole('navigation', { name: 'Settings sections' });
      expect(
        within(sections)
          .getAllByRole('button')
          .map((link) => link.textContent),
      ).toEqual(['Appearance', 'Profile', 'Index', 'Images', 'Quick add', 'About']);
      expect(screen.queryByRole('switch', { name: 'Local API' })).toBeNull();
    },
  );

  it('takes the window down again when asked', { timeout: 20_000 }, async () => {
    startedAsMainStartsIt();
    await screen.findByRole('treeitem', { name: 'Welcome' }, { timeout: 10_000 });
    unmount?.();
    unmount = null;
    await waitFor(() => expect(document.getElementById('root')?.childElementCount).toBe(0));
  });
});
