// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { mountShell, type AppPorts } from './mount-shell.tsx';

// mountShell's own work, without the window it draws: the app and its later pages stand in.
vi.mock('./app.tsx', () => ({ App: () => <p>the app</p> }));
vi.mock('./pages-on-first-use.ts', () => ({ preloadPages: async () => {} }));

/** Never read: the app that would read them is the stand-in above. */
const ports = {} as AppPorts;

/** A file dragged in from the Finder, as the webview would navigate to it. */
function fileDrop(): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  return Object.assign(event, { dataTransfer: { types: ['Files'], dropEffect: 'copy' } });
}

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  document.body.innerHTML = '';
});

const mounted = () => {
  document.body.innerHTML = '<div id="root"></div>';
  unmount = mountShell({ ports });
};

describe('mountShell (#656)', () => {
  it('says so when the page has nowhere to draw the app', () => {
    document.body.innerHTML = '<main></main>';
    expect(() => mountShell({ ports })).toThrow('index.html is missing #root');
  });

  it('draws the app into #root and takes it down again', async () => {
    mounted();
    expect(await screen.findByText('the app')).toBeDefined();
    unmount?.();
    unmount = null;
    await waitFor(() => expect(document.getElementById('root')?.childElementCount).toBe(0));
  });

  it('refuses a file dropped on the page while it holds the app, and not after', async () => {
    mounted();
    await screen.findByText('the app');
    const held = fileDrop();
    document.body.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    unmount?.();
    unmount = null;
    const after = fileDrop();
    document.body.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('refuses a second app on a page that holds one, and takes one again once it is down', () => {
    mounted();
    expect(() => mountShell({ ports })).toThrow('this page already holds the app');
    unmount?.();
    unmount = null;
    expect(() => mounted()).not.toThrow();
  });
});
