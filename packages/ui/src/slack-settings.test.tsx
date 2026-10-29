// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SlackSettings, type SlackView } from './slack-settings.tsx';

/* #105: Settings → Slack, which hands a token on and never shows one. */

const TOKEN = 'xoxp-1111-2222-fictional';
const SCOPES = ['channels:history', 'users:read'];

function renderWith(overrides: Partial<SlackView> = {}) {
  const view: SlackView = {
    tokenState: 'none',
    workspace: null,
    user: null,
    scopes: SCOPES,
    problem: null,
    pending: false,
    ...overrides,
  };
  const handlers = { onConnect: vi.fn(), onDisconnect: vi.fn() };
  render(<SlackSettings view={view} {...handlers} />);
  return handlers;
}

const card = () => screen.getByRole('region', { name: 'Slack' });
const status = () => within(card()).getByTestId('slack-token').textContent;
const field = () => within(card()).getByLabelText<HTMLInputElement>('Slack user token');

describe('SlackSettings', () => {
  it('with no token, says how to make one with the scopes DFAI reads with', () => {
    renderWith();
    expect(status()).toBe('Not connected on this Mac');
    expect(card().textContent).toContain('channels:history, users:read');
    expect(within(card()).queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('hands a pasted token on, masked, and empties the field as it goes', async () => {
    const { onConnect } = renderWith();
    expect(field().type).toBe('password');
    await userEvent.type(field(), `  ${TOKEN} `);
    await userEvent.click(within(card()).getByRole('button', { name: 'Connect' }));
    expect(onConnect).toHaveBeenCalledWith(TOKEN);
    expect(field().value).toBe('');
    expect(card().textContent).not.toContain(TOKEN);
  });

  it('connected, says as whom and in which workspace, and can disconnect', async () => {
    const { onDisconnect } = renderWith({
      tokenState: 'connected',
      workspace: 'Larkspur Payroll',
      user: 'mara',
    });
    expect(status()).toBe('Connected as mara in Larkspur Payroll');
    expect(card().textContent).not.toContain('channels:history');
    await userEvent.click(within(card()).getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it('says when Slack refused the token, with the problem', () => {
    renderWith({ tokenState: 'refused', problem: 'Slack refused the token.' });
    expect(status()).toBe('Slack refused this token');
    expect(within(card()).getByRole('alert').textContent).toBe('Slack refused the token.');
  });

  it('cannot connect or disconnect again while a change is under way', async () => {
    renderWith({ tokenState: 'set', pending: true });
    await userEvent.type(field(), TOKEN);
    expect(within(card()).getByRole('button', { name: 'Connect' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(card()).getByRole('button', { name: 'Disconnect' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
