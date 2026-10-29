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
  | 'slack_error'
  /** A token pasted into Settings that is not a user token, refused before the host is asked. */
  | 'not_a_user_token'
  /** A reply further down its thread than DFAI reads; the message is how far that is. */
  | 'past_thread_limit';

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

/** What went wrong, in the person's words, what to do, and whether the fix is in Settings → Slack. */
export interface SlackProblem {
  readonly problem: string;
  readonly fix: string;
  readonly inSettings: boolean;
}

/**
 * Where a failure is shown: the card a pasted link opens, where the link
 * stays as it was pasted, or Settings → Slack, where nothing was pasted.
 */
export type SlackFailureContext = 'paste' | 'settings';

/** What a user token starts with: one Slack issues with rotation on, too. Never a bot's (`xoxb-`). */
const USER_TOKEN = /^(?:xoxp-|xoxe\.xoxp-)[\x21-\x7e]+$/;

const NOT_A_USER_TOKEN =
  'That is not a Slack user token: paste the User OAuth Token, which starts xoxp-.';

/**
 * Why a token pasted into Settings → Slack cannot be one, or null when it
 * can. The host checks again (`slack/token.rs`), as the backstop for a
 * webview that skipped this; the words are this one's.
 */
export function slackTokenProblem(token: string): string | null {
  return USER_TOKEN.test(token) ? null : NOT_A_USER_TOKEN;
}

const CONNECT = 'Connect Slack in Settings → Slack, with a user token (xoxp-…).';
const KEPT_LINK = 'The link stays as you pasted it.';
const NEW_TOKEN = 'Make a new one and paste it in Settings → Slack.';

function waitWords(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'Try again in a minute.';
  return seconds <= 1 ? 'Try again in a second.' : `Try again in ${seconds} seconds.`;
}

/**
 * One failure's words: what went wrong, the fix on the paste card and in
 * Settings, and whether that fix is made in Settings → Slack.
 */
interface Words {
  readonly problem: string;
  readonly paste: string;
  readonly settings: string;
  readonly inSettings?: boolean;
}

const RECONNECT = 'Check the connection, then press Connect again.';

/** Each failure's words; a function where they depend on what was said. */
const WORDS: Readonly<Record<SlackFailureKind, (failure: SlackFailure) => Words>> = {
  no_token: () => ({
    problem: 'Slack is not connected on this Mac.',
    paste: CONNECT,
    settings: 'Paste a user token (xoxp-…) and press Connect.',
    inSettings: true,
  }),
  not_a_user_token: () => ({
    problem: NOT_A_USER_TOKEN,
    paste: CONNECT,
    settings: 'Copy it from the Slack app’s OAuth & Permissions page.',
    inSettings: true,
  }),
  refused: () => ({
    problem: 'Slack refused the token: it was revoked, expired, or is not a user token.',
    paste: `${NEW_TOKEN} ${KEPT_LINK}`,
    settings: 'Make a new one in the Slack app and paste it here.',
    inSettings: true,
  }),
  missing_scope: () => {
    const scopes = `Add the user token scopes ${SLACK_SCOPES.join(', ')} to the Slack app, reinstall it,`;
    return {
      problem: 'The Slack token is missing a scope DFAI needs to read this message.',
      paste: `${scopes} and paste the new token in Settings → Slack.`,
      settings: `${scopes} and paste the new token here.`,
      inSettings: true,
    };
  },
  not_found: () => ({
    problem:
      'You cannot read this message in Slack: it was deleted, or it is in a conversation you are not in.',
    paste: `${KEPT_LINK} Only the link was saved.`,
    settings: 'Check the token is yours, for the workspace you read in.',
  }),
  past_thread_limit: (failure) => ({
    problem: `This reply is past the first ${failure.message} messages of its thread, which is as far as DFAI reads.`,
    paste: `${KEPT_LINK} Only the link was saved.`,
    settings: 'Try a link to an earlier message of the thread.',
  }),
  rate_limited: (failure) => ({
    problem: 'Slack asked DFAI to slow down.',
    paste: waitWords(failure.retryAfter),
    settings: waitWords(failure.retryAfter),
  }),
  slack_error: (failure) => ({
    problem: `Slack could not answer (${failure.message}).`,
    paste: `Try again later. ${KEPT_LINK}`,
    settings: 'Try again later.',
  }),
  invalid: (failure) => ({
    problem: `DFAI could not read Slack: ${failure.message}.`,
    paste: KEPT_LINK,
    settings: 'Open Settings again and try once more.',
  }),
  keychain: (failure) => ({
    problem: `The Keychain did not give DFAI the Slack token: ${failure.message}.`,
    paste: 'Unlock the Keychain, or paste the token again in Settings → Slack.',
    settings: 'Unlock the Keychain, or paste the token again.',
    inSettings: true,
  }),
  unreachable: () => ({
    problem: 'Slack could not be reached.',
    paste: `Check the connection and paste the link again. ${KEPT_LINK}`,
    settings: RECONNECT,
  }),
  timeout: () => ({
    problem: 'Slack did not answer in time.',
    paste: `Check the connection and paste the link again. ${KEPT_LINK}`,
    settings: RECONNECT,
  }),
  too_large: () => ({
    problem: 'Slack answered with more than DFAI will read.',
    paste: KEPT_LINK,
    settings: 'Try again later.',
  }),
  malformed: (failure) => ({
    problem: `Slack answered in a way DFAI does not understand: ${failure.message}.`,
    paste: KEPT_LINK,
    settings: 'Try again later.',
  }),
};

/**
 * The person's problem, what to do about it where it is shown, and whether
 * the fix is in Settings → Slack (the paste card then offers a way there).
 */
export function explainSlackFailure(
  failure: SlackFailure,
  during: SlackFailureContext = 'paste',
): SlackProblem {
  const words = (WORDS[failure.kind] ?? WORDS.malformed)(failure);
  return {
    problem: words.problem,
    fix: during === 'paste' ? words.paste : words.settings,
    inSettings: words.inSettings === true,
  };
}
