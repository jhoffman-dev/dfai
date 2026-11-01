// @vitest-environment jsdom
/*
 * Second attack on PR #689 (#656): mountShell's one-app-per-page hold. A
 * teardown called twice (a hot reload, a cleanup run again) must not release
 * the hold of an app mounted after it. It was `it.fails` until it did not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { DESKTOP_CAPABILITIES } from '@dfai/domain';
import { mountShell, type AppPorts } from './mount-shell.tsx';

vi.mock('./app.tsx', () => ({ App: () => <p>the app</p> }));
vi.mock('./pages-on-first-use.ts', () => ({ preloadPages: async () => {} }));

/** Never read: the app that would read them is the stand-in above. */
const ports = {} as AppPorts;

const teardowns: (() => void)[] = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) {
    try {
      teardown();
    } catch {
      // A teardown already run may refuse to run again; the page is cleared below either way.
    }
  }
  document.body.innerHTML = '';
});

const mount = () => {
  const teardown = mountShell({ ports, capabilities: DESKTOP_CAPABILITIES });
  teardowns.push(teardown);
  return teardown;
};

describe('one app per page, whatever order teardowns come in (attack 2, #689)', () => {
  it('still refuses a second app after an old teardown runs again', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const first = mount();
    first();
    mount();
    expect(await screen.findByText('the app')).toBeDefined();
    first(); // The first app's teardown, run a second time.
    expect(() => mount()).toThrow('this page already holds the app');
  });
});
