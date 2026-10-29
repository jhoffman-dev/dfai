import { describe, expect, it } from 'vitest';
import {
  explainSlackFailure,
  SLACK_HOST_FAILURE_KINDS,
  slackTokenProblem,
  type SlackFailureKind,
} from './slack-failure.ts';

/*
 * Review of PR #631: Settings → Slack has words of its own, since no link was
 * pasted there; which failures are fixed in Settings is the domain's rule; and
 * a token that is not a user token is refused before the host is asked.
 */

const KINDS: SlackFailureKind[] = [
  ...SLACK_HOST_FAILURE_KINDS,
  'refused',
  'missing_scope',
  'not_found',
  'rate_limited',
  'slack_error',
  'not_a_user_token',
];

describe('what Settings → Slack is told', () => {
  it('never speaks of a pasted link, for any failure', () => {
    for (const kind of KINDS) {
      const { problem, fix } = explainSlackFailure({ kind, message: 'x' }, 'settings');
      expect(`${problem} ${fix}`, kind).not.toMatch(/link|pasted it/i);
    }
  });

  it('offline, says to connect again once Slack can be reached', () => {
    expect(explainSlackFailure({ kind: 'unreachable', message: '' }, 'settings').fix).toBe(
      'Check the connection, then press Connect again.',
    );
  });

  it('when another vault was opened, says Slack could not be read for this one', () => {
    expect(
      explainSlackFailure(
        { kind: 'invalid', message: 'another vault was opened before Slack could be asked' },
        'settings',
      ).problem,
    ).toBe('DFAI could not read Slack: another vault was opened before Slack could be asked.');
  });

  it('a pasted link still keeps its words', () => {
    expect(explainSlackFailure({ kind: 'unreachable', message: '' }).fix).toContain(
      'The link stays as you pasted it.',
    );
  });
});

describe('which failures are fixed in Settings → Slack', () => {
  it('are no token, a refused token, a missing scope, the Keychain and a token of the wrong shape', () => {
    const fixedThere = KINDS.filter(
      (kind) => explainSlackFailure({ kind, message: '' }).inSettings,
    );
    expect(fixedThere.sort()).toEqual(
      ['keychain', 'missing_scope', 'no_token', 'not_a_user_token', 'refused'].sort(),
    );
  });
});

describe('a token pasted into Settings → Slack', () => {
  it('is taken when it is a user token', () => {
    for (const token of ['xoxp-1111-2222-fictional', 'xoxe.xoxp-1-AbC']) {
      expect(slackTokenProblem(token), token).toBeNull();
    }
  });

  it('is refused, with its own words, when it is a bot token or anything else', () => {
    for (const token of ['xoxb-1111-bot', 'xoxp-', 'grn_abc', 'xoxp-ab c', 'XOXP-abc', '']) {
      expect(slackTokenProblem(token), token).toBe(
        'That is not a Slack user token: paste the User OAuth Token, which starts xoxp-.',
      );
    }
  });

  it('a token refused for its shape says so in Settings', () => {
    expect(explainSlackFailure({ kind: 'not_a_user_token', message: '' }, 'settings').problem).toBe(
      'That is not a Slack user token: paste the User OAuth Token, which starts xoxp-.',
    );
  });
});
