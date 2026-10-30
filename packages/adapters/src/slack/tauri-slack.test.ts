import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackError } from '@dfai/application';

/*
 * The Slack adapter against a fake `invoke`: the commands and arguments
 * `slack.rs` takes (#105), Slack's answers read by the domain's rule, and
 * every way the host or Slack can fail turned into the app's error.
 */

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { tauriSlack, slackErrorOf } = await import('./tauri-slack.ts');

const VAULT = '/Users/mara/Vault';
const answer = (body: unknown, status = 200, retryAfter: number | null = null) => ({
  status,
  body: typeof body === 'string' ? body : JSON.stringify(body),
  retryAfter,
});
const call = () =>
  tauriSlack.call({
    vault: VAULT,
    method: 'conversations.replies',
    query: { channel: 'C0LARK5PUR' },
  });

beforeEach(() => {
  invoke.mockReset();
});

describe('tauriSlack', () => {
  it('sends the method and query for the vault, and hands back what Slack said', async () => {
    invoke.mockResolvedValue(answer({ ok: true, messages: [] }));
    expect(await call()).toEqual({ ok: true, messages: [] });
    expect(invoke).toHaveBeenCalledWith('slack_request', {
      vault: VAULT,
      method: 'conversations.replies',
      query: { channel: 'C0LARK5PUR' },
    });
  });

  it('turns Slack’s ok: false into the failure it means', async () => {
    invoke.mockResolvedValue(answer({ ok: false, error: 'not_in_channel' }));
    await expect(call()).rejects.toMatchObject({ failure: { kind: 'not_found' } });
    invoke.mockResolvedValue(answer({ ok: false, error: 'ratelimited' }, 429, 12));
    await expect(call()).rejects.toMatchObject({
      failure: { kind: 'rate_limited', retryAfter: 12 },
    });
  });

  it('reads an answer that is not JSON as malformed', async () => {
    invoke.mockResolvedValue(answer('<html>'));
    await expect(call()).rejects.toMatchObject({ failure: { kind: 'malformed' } });
  });

  it('turns the host’s refusal into its kind, and anything else into invalid', async () => {
    invoke.mockRejectedValue({ kind: 'no_token', message: 'no Slack token is kept' });
    await expect(call()).rejects.toMatchObject({ failure: { kind: 'no_token' } });
    expect(slackErrorOf(new Error('bad args'))).toBeInstanceOf(SlackError);
    expect(slackErrorOf({ kind: 'refused', message: 'x' }).failure.kind).toBe('invalid');
  });

  it('keeps and forgets the token through the host, which answers only whether one is kept', async () => {
    invoke.mockResolvedValue({ hasToken: true });
    expect(await tauriSlack.connect({ vault: VAULT, token: 'xoxp-1-fictional' })).toEqual({
      hasToken: true,
    });
    expect(invoke).toHaveBeenCalledWith('slack_connect', {
      vault: VAULT,
      token: 'xoxp-1-fictional',
    });
    invoke.mockResolvedValue({ hasToken: false });
    expect(await tauriSlack.disconnect({ vault: VAULT })).toEqual({ hasToken: false });
    expect(await tauriSlack.status({ vault: VAULT })).toEqual({ hasToken: false });
    expect(invoke).toHaveBeenCalledWith('slack_status', { vault: VAULT });
    invoke.mockResolvedValue('nonsense');
    await expect(tauriSlack.status({ vault: VAULT })).rejects.toMatchObject({
      failure: { kind: 'malformed' },
    });
  });
});
