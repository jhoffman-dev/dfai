import { describe, expect, it } from 'vitest';
import {
  explainSlackFailure,
  SLACK_HOST_FAILURE_KINDS,
  SLACK_SCOPES,
  slackAnswerFailure,
  type SlackFailure,
  type SlackFailureKind,
} from './slack-failure.ts';

/* #105: what Slack's answer means, and what the person is told to do. */

const answer = (body: unknown, status = 200, retryAfter: number | null = null) =>
  slackAnswerFailure({ status, body, retryAfter });

describe('a Slack answer', () => {
  it('that is ok is no failure', () => {
    expect(answer({ ok: true })).toBeNull();
  });

  it('refusing the token, for each of Slack’s ways of saying so, is refused', () => {
    for (const error of ['not_authed', 'invalid_auth', 'token_revoked', 'token_expired']) {
      expect(answer({ ok: false, error })?.kind, error).toBe('refused');
    }
  });

  it('for a message the token cannot see is not found', () => {
    for (const error of [
      'channel_not_found',
      'message_not_found',
      'thread_not_found',
      'not_in_channel',
    ]) {
      expect(answer({ ok: false, error })?.kind, error).toBe('not_found');
    }
  });

  it('that is a 429, or says ratelimited, is rate limited with how long to wait', () => {
    expect(answer({ ok: false, error: 'ratelimited' }, 429, 30)).toEqual({
      kind: 'rate_limited',
      message: 'ratelimited',
      retryAfter: 30,
    });
    expect(answer('', 429, null)?.retryAfter).toBeNull();
    expect(answer({ ok: false, error: 'ratelimited' }, 200, -1)?.retryAfter).toBeNull();
  });

  it('lacking a scope is missing_scope; any other code is Slack’s, named', () => {
    expect(answer({ ok: false, error: 'missing_scope' })?.kind).toBe('missing_scope');
    expect(answer({ ok: false, error: 'team_access_not_granted' })).toEqual({
      kind: 'slack_error',
      message: 'team_access_not_granted',
    });
  });

  it('with another status is Slack’s trouble, and one DFAI cannot read is malformed', () => {
    expect(answer({ ok: true }, 503)).toEqual({ kind: 'slack_error', message: 'status 503' });
    expect(answer(null)?.kind).toBe('malformed');
    expect(answer({ ok: false })?.kind).toBe('malformed');
  });
});

describe('what the person is told', () => {
  it('without a token, is to connect Slack in Settings', () => {
    expect(explainSlackFailure({ kind: 'no_token', message: '' }).fix).toContain(
      'Settings → Slack',
    );
  });

  it('for a message they cannot read, says so and that only the link was saved', () => {
    const { problem, fix } = explainSlackFailure({ kind: 'not_found', message: 'not_in_channel' });
    expect(problem).toContain('cannot read this message');
    expect(fix).toContain('Only the link was saved');
  });

  it('for a refused token, is to paste a new one', () => {
    expect(explainSlackFailure({ kind: 'refused', message: 'invalid_auth' }).fix).toContain(
      'paste it in Settings → Slack',
    );
  });

  it('for a missing scope, names every scope DFAI reads with', () => {
    const { fix } = explainSlackFailure({ kind: 'missing_scope', message: 'missing_scope' });
    for (const scope of SLACK_SCOPES) expect(fix).toContain(scope);
  });

  it('when rate limited, says how long to wait when Slack said', () => {
    expect(explainSlackFailure({ kind: 'rate_limited', message: '', retryAfter: 30 }).fix).toBe(
      'Try again in 30 seconds.',
    );
    expect(explainSlackFailure({ kind: 'rate_limited', message: '', retryAfter: null }).fix).toBe(
      'Try again in a minute.',
    );
  });

  it('for every failure the host or Slack can report, says what went wrong and what to do', () => {
    const kinds: SlackFailureKind[] = [
      ...SLACK_HOST_FAILURE_KINDS,
      'refused',
      'missing_scope',
      'not_found',
      'rate_limited',
      'slack_error',
    ];
    const said = kinds.map((kind) => explainSlackFailure({ kind, message: 'Fictional cause' }));
    for (const [at, { problem, fix }] of said.entries()) {
      expect(problem, kinds[at]).not.toBe('');
      expect(fix, kinds[at]).not.toBe('');
    }
    // No two kinds read alike: each says its own thing.
    expect(new Set(said.map(({ problem }) => problem)).size).toBe(kinds.length);
  });

  it('names what the host or Slack said, where it says something of its own', () => {
    for (const kind of ['invalid', 'keychain', 'malformed', 'slack_error'] as const) {
      expect(explainSlackFailure({ kind, message: 'team_access_not_granted' }).problem).toContain(
        'team_access_not_granted',
      );
    }
  });

  it('for a kind it does not know, reads it as an answer DFAI cannot understand', () => {
    const unknown = { kind: 'gone_fishing', message: 'odd' } as unknown as SlackFailure;
    expect(explainSlackFailure(unknown).problem).toContain('does not understand');
  });
});
