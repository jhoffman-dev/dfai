// @vitest-environment jsdom
import {
  countingRandom,
  createAuthService,
  fakeAuthGateway,
  fakeSha256,
  memoryPendingSignIn,
} from '@dfai/application';
import { SIGN_IN_MESSAGES } from '@dfai/ui';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWeb } from './start-web.tsx';

/**
 * #663: the web build starts at its sign-in, and shows the app only while
 * the session is there. The session is the real service over a fake of the
 * sign-in function.
 */

let stop: (() => void) | null = null;
afterEach(() => {
  act(() => stop?.());
  stop = null;
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

function setUp() {
  document.body.innerHTML = '<div id="root"></div>';
  const gateway = fakeAuthGateway();
  const pending = memoryPendingSignIn();
  const auth = createAuthService({
    gateway,
    pending,
    random: countingRandom(),
    sha256: fakeSha256,
    clock: { now: () => Date.UTC(2026, 9, 31, 9) },
  });
  const app = { mounts: 0, teardowns: 0 };
  const mountApp = () => {
    app.mounts += 1;
    document.getElementById('root')?.append(
      Object.assign(document.createElement('p'), {
        textContent: 'The app',
      }),
    );
    return () => {
      app.teardowns += 1;
      document.getElementById('root')?.replaceChildren();
    };
  };
  const start = async () => {
    stop = await act(() => startWeb({ auth, mountApp }));
  };
  return { gateway, pending, auth, app, start };
}

describe('the web build’s start', () => {
  it('shows the sign-in screen without a session, and leaves for GitHub from it', async () => {
    const { gateway, start, app } = setUp();
    await start();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    await waitFor(() =>
      expect(gateway.calls.map((call) => call.kind)).toEqual(['refresh', 'start']),
    );
    expect(app.mounts).toBe(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens the app from the cookie, with a way to sign out', async () => {
    const { gateway, start, app } = setUp();
    gateway.hasCookie = true;
    await start();
    expect(screen.getByText('The app')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub' })).toBeNull();
    expect(app.mounts).toBe(1);
  });

  it('redeems GitHub’s callback, taking the code out of the address bar first', async () => {
    const { gateway, pending, auth, start } = setUp();
    await auth.signIn();
    gateway.codes.add('c0de');
    window.history.replaceState(null, '', `/auth/callback?code=c0de&state=${pending.held?.state}`);
    let addressWhenRedeemed = '';
    const exchange = gateway.exchange;
    gateway.exchange = (args) => {
      addressWhenRedeemed = window.location.href;
      return exchange(args);
    };
    await start();
    expect(addressWhenRedeemed).toBe(`${window.location.origin}/`);
    expect(screen.getByText('The app')).toBeDefined();
  });

  it('reads a code on any other page as no callback, and takes it off the address bar', async () => {
    const { gateway, pending, auth, start } = setUp();
    await auth.signIn();
    gateway.codes.add('c0de');
    window.history.replaceState(
      null,
      '',
      `/notes?view=board&code=c0de&state=${pending.held?.state}#top`,
    );
    await start();
    expect(gateway.calls.some((call) => call.kind === 'exchange')).toBe(false);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/notes?view=board#top',
    );
  });

  it('leaves an ordinary query where it is', async () => {
    const { start } = setUp();
    window.history.replaceState(null, '', '/notes?view=board');
    const replaced = vi.spyOn(window.history, 'replaceState');
    await start();
    expect(window.location.search).toBe('?view=board');
    // Untouched, not rewritten to the same: history is left as the person made it.
    expect(replaced).not.toHaveBeenCalled();
    replaced.mockRestore();
  });

  it('takes the app down and shows the sign-in again on signing out', async () => {
    const { gateway, start, app } = setUp();
    gateway.hasCookie = true;
    await start();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeDefined();
    expect(app.teardowns).toBe(1);
    expect(screen.queryByText('The app')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(gateway.hasCookie).toBe(false);
  });

  it('says so clearly when GitHub no longer lets DFAI in', async () => {
    const { gateway, auth, start, app } = setUp();
    gateway.hasCookie = true;
    await start();
    gateway.revoked = true;
    await act(() => auth.rejected('ghu_token1'));
    expect((await screen.findByRole('alert')).textContent).toBe(SIGN_IN_MESSAGES.revoked);
    expect(app.teardowns).toBe(1);
  });

  it('says why when the person said no on GitHub', async () => {
    const { pending, auth, start } = setUp();
    await auth.signIn();
    window.history.replaceState(
      null,
      '',
      `/auth/callback?error=access_denied&state=${pending.held?.state}`,
    );
    await start();
    expect(screen.getByRole('alert').textContent).toBe(SIGN_IN_MESSAGES.denied);
  });
});
