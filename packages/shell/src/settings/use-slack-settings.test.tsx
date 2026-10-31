// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeSlack } from '@dfai/application';
import { useSlackSettings } from './use-slack-settings.ts';

/* #105: Settings → Slack over a fake host — asked only while drawn. */

const VAULT = '/vaults/larkspur';
const WHO = { ok: true, team: 'Larkspur Payroll', user: 'mara' };

describe('useSlackSettings', () => {
  it('with no token, says so, and asks Slack nothing', async () => {
    const slack = fakeSlack(() => WHO, { hasToken: false });
    const hook = renderHook(() => useSlackSettings({ port: slack, vault: VAULT }));
    expect(hook.result.current.view.tokenState).toBe('checking');
    await waitFor(() => expect(hook.result.current.view.tokenState).toBe('none'));
    expect(slack.calls).toEqual([]);
  });

  it('with a token kept, asks Slack whose it is', async () => {
    const slack = fakeSlack(() => WHO);
    const hook = renderHook(() => useSlackSettings({ port: slack, vault: VAULT }));
    await waitFor(() => expect(hook.result.current.view.tokenState).toBe('connected'));
    expect(hook.result.current.view).toMatchObject({
      workspace: 'Larkspur Payroll',
      user: 'mara',
      problem: null,
    });
  });

  it('connecting keeps the token and says when Slack refused it', async () => {
    const slack = fakeSlack(() => ({ ok: false, error: 'invalid_auth' }), { hasToken: false });
    const hook = renderHook(() => useSlackSettings({ port: slack, vault: VAULT }));
    await waitFor(() => expect(hook.result.current.view.tokenState).toBe('none'));
    act(() => hook.result.current.connect('xoxp-1-old'));
    await waitFor(() => expect(hook.result.current.view.tokenState).toBe('refused'));
    expect(hook.result.current.view.problem).toContain('Slack refused the token');
    // Settings' own words: no link was pasted here.
    expect(hook.result.current.view.problem).not.toMatch(/link/i);
    expect(slack.hasToken).toBe(true);
  });

  it('disconnecting forgets the token', async () => {
    const slack = fakeSlack(() => WHO);
    const hook = renderHook(() => useSlackSettings({ port: slack, vault: VAULT }));
    await waitFor(() => expect(hook.result.current.view.tokenState).toBe('connected'));
    act(() => hook.result.current.disconnect());
    await waitFor(() => expect(hook.result.current.view.tokenState).toBe('none'));
    expect(slack.hasToken).toBe(false);
  });

  it('refuses a token that is not a user token in its own words, never handing it to the host', async () => {
    const slack = fakeSlack(() => WHO, { hasToken: false });
    const connect = vi.spyOn(slack, 'connect');
    const hook = renderHook(() => useSlackSettings({ port: slack, vault: VAULT }));
    await waitFor(() => expect(hook.result.current.view.tokenState).toBe('none'));
    act(() => hook.result.current.connect('xoxb-1111-bot'));
    await waitFor(() => expect(hook.result.current.view.problem).not.toBeNull());
    expect(hook.result.current.view.problem).toMatch(
      /^That is not a Slack user token: paste the User OAuth Token, which starts xoxp-\. /,
    );
    expect(connect).not.toHaveBeenCalled();
    expect(hook.result.current.view.tokenState).toBe('none');
  });
});
