/**
 * Why Google Calendar did not do what was asked, and what the person can do
 * about it. The host says what happened (a kind, and the OAuth code Google
 * gave); what that means for the person is decided here.
 */

import { GOOGLE_SCOPES_BY_USE } from './google-scopes.ts';

export const GOOGLE_FAILURE_KINDS = [
  'not_connected',
  'busy',
  'refused',
  'timeout',
  'cancelled',
  'scope_not_granted',
  'token_refused',
  'malformed',
  'unreachable',
  'invalid',
  'keychain',
  /** The Calendar API answered a call with an error status; `code` is the status. */
  'api_refused',
] as const;

export type GoogleFailureKind = (typeof GOOGLE_FAILURE_KINDS)[number];

export interface GoogleFailure {
  readonly kind: GoogleFailureKind;
  /** The OAuth error code Google gave, or an API call's status. */
  readonly code?: string;
  readonly message: string;
}

/** What went wrong in the person's words, and what to do; null when there is nothing to do. */
export interface GoogleProblem {
  readonly problem: string;
  readonly fix: string | null;
}

export function isGoogleFailureKind(value: unknown): value is GoogleFailureKind {
  return (GOOGLE_FAILURE_KINDS as readonly unknown[]).includes(value);
}

const CONNECT_AGAIN = 'Connect again in Settings → Google Calendar.';

/** Google sent the browser back without a code. */
function refusal(code: string | undefined): GoogleProblem {
  if (code === 'access_denied') {
    return {
      problem: 'Google Calendar was not connected: access was not allowed.',
      fix: 'Connect again and choose Allow. If it is a work account and Allow is not offered, its administrator has to trust the client ID first.',
    };
  }
  if (code === 'admin_policy_enforced' || code === 'org_internal') {
    return {
      problem: 'This Google account’s administrator does not allow this client.',
      fix: 'Ask them to trust the client ID, or use a client from a Google Cloud project the account belongs to.',
    };
  }
  return {
    problem: `Google refused the sign-in (${code ?? 'no reason given'}).`,
    fix: 'Check the client ID in Settings → Google Calendar, then connect again.',
  };
}

/** Google's token endpoint refused a code or a refresh token. */
function tokenRefusal(code: string | undefined): GoogleProblem {
  if (code === 'invalid_grant') {
    return {
      problem: 'Google no longer accepts DFAI’s sign-in: it expired or was revoked.',
      fix: `${CONNECT_AGAIN} If this happens every week, the Google Cloud project’s consent screen is in Testing, where sign-ins last seven days; publish it to keep them.`,
    };
  }
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return {
      problem: 'Google does not recognise this client.',
      fix: 'Check the client ID, and the client secret if Google issued one, then connect again.',
    };
  }
  return {
    problem: `Google refused the sign-in (${code ?? 'no reason given'}).`,
    fix: 'If Google issued a client secret with this client ID, enter it and connect again.',
  };
}

/**
 * A consent screen with a permission left unticked. The host names the
 * scope it did not get, so the meetings one is told apart (ADR-0046).
 */
function scopeRefusal(message: string): GoogleProblem {
  if (GOOGLE_SCOPES_BY_USE.meetings.some((scope) => message.includes(scope))) {
    return {
      problem:
        'Meetings are not read: the permission to see your calendar’s events was left unticked.',
      fix: 'Choose Allow reading meetings again and tick the permission to view events on your calendars.',
    };
  }
  return {
    problem: 'Google Calendar was not connected: the calendar permission was left unticked.',
    fix: 'Connect again and tick the permission to make and change DFAI’s own calendars.',
  };
}

/** The person's problem and its fix, for any failure. */
export function explainGoogleFailure(failure: GoogleFailure): GoogleProblem {
  switch (failure.kind) {
    case 'refused':
      return refusal(failure.code);
    case 'token_refused':
      return tokenRefusal(failure.code);
    case 'scope_not_granted':
      return scopeRefusal(failure.message);
    case 'timeout':
      return {
        problem: 'No answer came back from the browser in time.',
        fix: 'Connect again and finish signing in in the browser.',
      };
    case 'cancelled':
      return { problem: 'Connecting was cancelled.', fix: null };
    case 'busy':
      return {
        problem: 'A Google sign-in is already waiting in the browser.',
        fix: 'Finish it there, or cancel it here.',
      };
    case 'not_connected':
      return { problem: 'Google Calendar is not connected on this Mac.', fix: CONNECT_AGAIN };
    case 'unreachable':
      return {
        problem: `Google could not be reached: ${failure.message}.`,
        fix: 'Check the connection and try again.',
      };
    case 'keychain':
      return {
        problem: `The Keychain did not keep the sign-in: ${failure.message}.`,
        fix: 'Unlock the login keychain, then connect again.',
      };
    case 'api_refused':
      return {
        problem: `Google Calendar refused the request (${failure.code ?? 'no status'}).`,
        fix: failure.code === '403' ? CONNECT_AGAIN : 'Try again.',
      };
    case 'malformed':
      return {
        problem: `Google answered in a way DFAI does not understand: ${failure.message}.`,
        fix: 'Try again; if it keeps happening, connect again.',
      };
    case 'invalid':
      return { problem: failure.message, fix: null };
  }
}
