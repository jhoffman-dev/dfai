import { slackTokenProblem } from '@dfai/domain';
import { SlackError, type SlackPort } from './ports.ts';

/** Who Slack says the token reads as, from `auth.test`. */
export interface SlackIdentity {
  readonly workspace: string | null;
  readonly user: string | null;
}

const named = (answer: unknown, field: string): string | null => {
  if (typeof answer !== 'object' || answer === null) return null;
  const value = (answer as Readonly<Record<string, unknown>>)[field];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
};

/** Asks Slack whose the vault's token is. Throws a `SlackError` when Slack will not say. */
export async function checkSlack({
  slack,
  vault,
}: {
  slack: SlackPort;
  vault: string;
}): Promise<SlackIdentity> {
  const answer = await slack.call({ vault, method: 'auth.test', query: {} });
  return { workspace: named(answer, 'team'), user: named(answer, 'user') };
}

/**
 * Keeps the token the person pasted — refused before the host is handed it
 * when it is not a user token — then asks Slack once with it, so that a
 * token Slack will not take is known at once rather than at the next paste.
 * The token is kept either way, as Granola's key is (ADR-0034): a Slack that
 * cannot be reached says nothing about it.
 */
export async function connectSlack({
  slack,
  vault,
  token,
}: {
  slack: SlackPort;
  vault: string;
  token: string;
}): Promise<SlackIdentity> {
  const problem = slackTokenProblem(token);
  if (problem !== null) throw new SlackError({ kind: 'not_a_user_token', message: problem });
  await slack.connect({ vault, token });
  return checkSlack({ slack, vault });
}
