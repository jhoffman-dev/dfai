import { describe, expect, it } from 'vitest';
import {
  LONGEST_ACCESS_MS,
  REFRESH_MARGIN_MS,
  sessionFreshness,
  sessionFromGrant,
} from './auth-session.ts';

/** #663, ADR-0052: when a GitHub access token is used, refreshed first, or no longer sent. */

const NOW = Date.UTC(2026, 9, 31, 9, 0, 0);
const EIGHT_HOURS = 8 * 60 * 60;

describe('a session from a grant', () => {
  it('expires when GitHub says, counted from now', () => {
    expect(
      sessionFromGrant({ accessToken: 'ghu_abc', expiresInSeconds: EIGHT_HOURS }, NOW),
    ).toEqual({ accessToken: 'ghu_abc', expiresAt: NOW + EIGHT_HOURS * 1000 });
  });

  it('is refused for a token that is empty, spaced, or not a token', () => {
    for (const accessToken of ['', 'ghu abc', 'ghu_abc\n', 'tok;en', 'x'.repeat(513)])
      expect(sessionFromGrant({ accessToken, expiresInSeconds: EIGHT_HOURS }, NOW)).toBeNull();
  });

  it('is refused for a lifetime within the refresh margin, which would refresh on every request', () => {
    const margin = REFRESH_MARGIN_MS / 1000;
    expect(sessionFromGrant({ accessToken: 't', expiresInSeconds: margin }, NOW)).toBeNull();
    expect(
      sessionFromGrant({ accessToken: 't', expiresInSeconds: margin + 1 }, NOW),
    ).not.toBeNull();
  });

  it('is refused for a lifetime over a day, so a token that never expires is not a session', () => {
    const day = LONGEST_ACCESS_MS / 1000;
    expect(sessionFromGrant({ accessToken: 't', expiresInSeconds: day }, NOW)).not.toBeNull();
    expect(sessionFromGrant({ accessToken: 't', expiresInSeconds: day + 1 }, NOW)).toBeNull();
  });

  it('is refused for a lifetime that is not a whole number of seconds', () => {
    for (const expiresInSeconds of [Number.NaN, Infinity, -EIGHT_HOURS, 0, 3600.5])
      expect(sessionFromGrant({ accessToken: 't', expiresInSeconds }, NOW)).toBeNull();
  });
});

describe('a session’s freshness', () => {
  const session = { accessToken: 't', expiresAt: NOW + EIGHT_HOURS * 1000 };
  const due = session.expiresAt - REFRESH_MARGIN_MS;

  it('is fresh until the refresh margin before expiry', () => {
    expect(sessionFreshness(session, NOW)).toBe('fresh');
    expect(sessionFreshness(session, due - 1)).toBe('fresh');
  });

  it('is due a refresh from the margin until it expires', () => {
    expect(sessionFreshness(session, due)).toBe('refresh-due');
    expect(sessionFreshness(session, session.expiresAt - 1)).toBe('refresh-due');
  });

  it('is expired from the moment it expires', () => {
    expect(sessionFreshness(session, session.expiresAt)).toBe('expired');
    expect(sessionFreshness(session, session.expiresAt + 1)).toBe('expired');
  });
});
