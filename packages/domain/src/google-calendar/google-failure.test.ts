import { describe, expect, it } from 'vitest';
import {
  explainGoogleFailure,
  isGoogleFailureKind,
  GOOGLE_FAILURE_KINDS,
  type GoogleFailure,
} from './google-failure.ts';

const failure = (kind: GoogleFailure['kind'], code?: string): GoogleFailure => ({
  kind,
  message: 'what the host said',
  ...(code === undefined ? {} : { code }),
});

describe('explainGoogleFailure', () => {
  it('tells someone who refused consent to connect again and allow it', () => {
    const { problem, fix } = explainGoogleFailure(failure('refused', 'access_denied'));
    expect(problem).toMatch(/not allowed/);
    expect(fix).toMatch(/choose Allow/);
  });

  it('names a workspace policy that blocks the client, and who can lift it', () => {
    const { problem, fix } = explainGoogleFailure(failure('refused', 'admin_policy_enforced'));
    expect(problem).toMatch(/administrator/);
    expect(fix).toMatch(/trust the client ID/);
  });

  it('tells someone whose sign-in expired to connect again, and why it may be weekly', () => {
    const { problem, fix } = explainGoogleFailure(failure('token_refused', 'invalid_grant'));
    expect(problem).toMatch(/expired or was revoked/);
    expect(fix).toMatch(/Connect again/);
    expect(fix).toMatch(/Testing/);
  });

  it('points a client Google does not know back at the client ID and secret', () => {
    expect(explainGoogleFailure(failure('token_refused', 'invalid_client')).fix).toMatch(
      /client ID, and the client secret/,
    );
  });

  it('asks for the client secret when Google refuses a request without saying more', () => {
    expect(explainGoogleFailure(failure('token_refused', 'invalid_request')).fix).toMatch(
      /client secret/,
    );
  });

  it('tells someone who unticked the calendar permission to tick it', () => {
    expect(explainGoogleFailure(failure('scope_not_granted')).fix).toMatch(/tick the permission/);
  });

  it('has nothing to fix after a cancel, and passes an invalid request on as said', () => {
    expect(explainGoogleFailure(failure('cancelled')).fix).toBeNull();
    expect(explainGoogleFailure(failure('invalid'))).toEqual({
      problem: 'what the host said',
      fix: null,
    });
  });

  it('sends a calendar call refused for its permission back to connecting', () => {
    expect(explainGoogleFailure(failure('api_refused', '403')).fix).toMatch(/Connect again/);
    expect(explainGoogleFailure(failure('api_refused', '500')).fix).toBe('Try again.');
  });

  it('explains every kind the host can send', () => {
    for (const kind of GOOGLE_FAILURE_KINDS) {
      expect(explainGoogleFailure(failure(kind)).problem, kind).not.toBe('');
    }
  });
});

describe('isGoogleFailureKind', () => {
  it('knows the kinds and nothing else', () => {
    expect(isGoogleFailureKind('refused')).toBe(true);
    expect(isGoogleFailureKind('token')).toBe(false);
    expect(isGoogleFailureKind(undefined)).toBe(false);
  });
});

describe('explainGoogleFailure: a permission left unticked (ADR-0046)', () => {
  it('tells the meetings permission apart from the calendar one', () => {
    expect(
      explainGoogleFailure({
        kind: 'scope_not_granted',
        message: 'Google did not grant https://www.googleapis.com/auth/calendar.events.readonly',
      }).problem,
    ).toContain('see your calendar’s events');
    expect(
      explainGoogleFailure({
        kind: 'scope_not_granted',
        message: 'Google did not grant https://www.googleapis.com/auth/calendar.app.created',
      }).problem,
    ).toContain('the calendar permission was left unticked');
  });
});
