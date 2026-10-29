/**
 * Why a Slack message could not be read, and what the person can do about it
 * (#105). The host says what happened to the request (a kind) and hands back
 * Slack's answer; what Slack's answer means, and what to tell the person, is
 * decided here.
 */

/** What the host reports of a request it could not make or finish. */
export const SLACK_HOST_FAILURE_KINDS = [
  /** No Slack token is kept for the vault on this Mac. */
  'no_token',
  /** The host would not send it: no vault open, not the one named, a method off its list, not a user token. */
  'invalid',
  /** The Keychain would not keep or give the token. */
  'keychain',
  'unreachable',
  'timeout',
  /** Slack's answer is larger than the host will read. */
  'too_large',
  /** Slack answered with something DFAI cannot read. */
  'malformed',
] as const;

/** What Slack's own answer says went wrong. */
type SlackAnswerFailureKind =
  /** Slack does not accept the token: revoked, expired, or never valid. */
  | 'refused'
  /** The token lacks a scope the method needs. */
  | 'missing_scope'
  /** The message, its channel or its thread is gone, or not the reader's to see. */
  | 'not_found'
  /** Slack asked DFAI to slow down; `retryAfter` says for how long, when it did. */
  | 'rate_limited'
  /** Any other refusal; the message is Slack's code for it. */
  | 'slack_error';

export type SlackHostFailureKind = (typeof SLACK_HOST_FAILURE_KINDS)[number];
export type SlackFailureKind = SlackHostFailureKind | SlackAnswerFailureKind;

export interface SlackFailure {
  readonly kind: SlackFailureKind;
  /** What the host said, or Slack's code; never a response body, which may hold the message. */
  readonly message: string;
  /** Seconds Slack asked DFAI to wait, for `rate_limited`, when it said. */
  readonly retryAfter?: number | null;
}

export function isSlackHostFailureKind(value: unknown): value is SlackHostFailureKind {
  return (SLACK_HOST_FAILURE_KINDS as readonly unknown[]).includes(value);
}

/** Slack's codes for a token it will not take (api.slack.com/methods, "Errors"). */
const REFUSED = new Set([
  'not_authed',
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'no_permission',
  'not_allowed_token_type',
]);

/** Slack's codes for a message the token cannot see. */
const NOT_FOUND = new Set([
  'channel_not_found',
  'message_not_found',
  'thread_not_found',
  'not_in_channel',
  'access_denied',
]);

/** A non-negative whole number of seconds, else null. */
const secondsOf = (value: number | null | undefined) =>
  value !== null && value !== undefined && Number.isInteger(value) && value >= 0 ? value : null;

/**
 * What one Web API answer means: null when Slack said `ok`, else the
 * failure. Slack refuses with a 200 and `ok: false`, and a 429 when DFAI asks
 * too often; any other status is its own trouble.
 */
export function slackAnswerFailure(answer: {
  readonly status: number;
  /** The body, parsed; null when it was not JSON. */
  readonly body: unknown;
  readonly retryAfter: number | null;
}): SlackFailure | null {
  const fields =
    typeof answer.body === 'object' && answer.body !== null
      ? (answer.body as Readonly<Record<string, unknown>>)
      : null;
  const error = typeof fields?.['error'] === 'string' ? fields['error'] : null;
  if (answer.status === 429 || error === 'ratelimited') {
    return {
      kind: 'rate_limited',
      message: 'ratelimited',
      retryAfter: secondsOf(answer.retryAfter),
    };
  }
  if (answer.status < 200 || answer.status > 299) {
    return { kind: 'slack_error', message: `status ${answer.status}` };
  }
  if (fields === null) return { kind: 'malformed', message: 'Slack did not answer with JSON' };
  if (fields['ok'] === true) return null;
  if (error === null) return { kind: 'malformed', message: 'Slack refused without saying why' };
  if (REFUSED.has(error)) return { kind: 'refused', message: error };
  if (error === 'missing_scope') return { kind: 'missing_scope', message: error };
  if (NOT_FOUND.has(error)) return { kind: 'not_found', message: error };
  return { kind: 'slack_error', message: error };
}

/** The user token scopes DFAI reads a message with: history for each kind of conversation, and names. */
export const SLACK_SCOPES = [
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'users:read',
  'users:read.email',
] as const;

/** What went wrong, in the person's words, and what to do. */
export interface SlackProblem {
  readonly problem: string;
  readonly fix: string;
}

const CONNECT = 'Connect Slack in Settings → Slack, with a user token (xoxp-…).';
const KEPT_LINK = 'The link stays as you pasted it.';

function waitWords(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'Try again in a minute.';
  return seconds <= 1 ? 'Try again in a second.' : `Try again in ${seconds} seconds.`;
}

/** Each failure's words; a function where they depend on what was said. */
const PROBLEMS: Readonly<Record<SlackFailureKind, (failure: SlackFailure) => SlackProblem>> = {
  no_token: () => ({ problem: 'Slack is not connected on this Mac.', fix: CONNECT }),
  refused: () => ({
    problem: 'Slack refused the token: it was revoked, expired, or is not a user token.',
    fix: `Make a new one and paste it in Settings → Slack. ${KEPT_LINK}`,
  }),
  missing_scope: () => ({
    problem: 'The Slack token is missing a scope DFAI needs to read this message.',
    fix: `Add the user token scopes ${SLACK_SCOPES.join(', ')} to the Slack app, reinstall it, and paste the new token in Settings → Slack.`,
  }),
  not_found: () => ({
    problem:
      'You cannot read this message in Slack: it was deleted, or it is in a conversation you are not in.',
    fix: `${KEPT_LINK} Only the link was saved.`,
  }),
  rate_limited: (failure) => ({
    problem: 'Slack asked DFAI to slow down.',
    fix: waitWords(failure.retryAfter),
  }),
  slack_error: (failure) => ({
    problem: `Slack could not send the message (${failure.message}).`,
    fix: `Try again later. ${KEPT_LINK}`,
  }),
  invalid: (failure) => ({
    problem: `DFAI could not ask Slack: ${failure.message}.`,
    fix: KEPT_LINK,
  }),
  keychain: (failure) => ({
    problem: `The Keychain did not give DFAI the Slack token: ${failure.message}.`,
    fix: 'Unlock the Keychain, or paste the token again in Settings → Slack.',
  }),
  unreachable: () => ({
    problem: 'Slack could not be reached.',
    fix: `Check the connection and paste the link again. ${KEPT_LINK}`,
  }),
  timeout: () => ({
    problem: 'Slack did not answer in time.',
    fix: `Check the connection and paste the link again. ${KEPT_LINK}`,
  }),
  too_large: () => ({
    problem: 'Slack answered with more than DFAI will read.',
    fix: KEPT_LINK,
  }),
  malformed: (failure) => ({
    problem: `Slack answered in a way DFAI does not understand: ${failure.message}.`,
    fix: KEPT_LINK,
  }),
};

/** The person's problem and what to do about it, for any failure. */
export function explainSlackFailure(failure: SlackFailure): SlackProblem {
  return (PROBLEMS[failure.kind] ?? PROBLEMS.malformed)(failure);
}
