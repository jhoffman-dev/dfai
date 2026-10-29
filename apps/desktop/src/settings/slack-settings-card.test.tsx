// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { fakeSlack } from '@dfai/application';
import { SlackSettingsCard } from './slack-settings-card.tsx';

/*
 * #105's guard on "Open Settings": drawing Settings → Slack asks the host
 * nothing until the section is shown, so opening Settings makes no
 * slack_status call (tools/perf/budgets.json holds it at 0).
 */

let seen: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
class FakeObserver {
  constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
    seen = callback;
  }
  observe() {}
  disconnect() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  seen = null;
});

describe('SlackSettingsCard', () => {
  it('asks slack_status only once the section is shown', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const slack = fakeSlack(() => ({ ok: true }), { hasToken: false });
    const status = vi.spyOn(slack, 'status');
    render(<SlackSettingsCard port={slack} vault="/vaults/larkspur" />);
    expect(screen.getByRole('heading', { name: 'Slack' })).toBeTruthy();
    expect(status).not.toHaveBeenCalled();

    await act(async () => seen?.([{ isIntersecting: true }]));
    expect(status).toHaveBeenCalledOnce();
    expect(await screen.findByText('Not connected on this Mac')).toBeTruthy();
  });
});
