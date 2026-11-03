import { describe, expect, it } from 'vitest';
import type { AuthState } from '../auth/ports.ts';
import { opensApp, waitsForNetwork } from './offline-session.ts';

const signedIn: AuthState = { status: 'signed-in' };
const offline: AuthState = { status: 'signed-out', reason: 'network' };
const signedOut: AuthState = { status: 'signed-out', reason: null };
const revoked: AuthState = { status: 'signed-out', reason: 'revoked' };

describe('opensApp', () => {
  it('opens the app signed in, with or without a vault kept', () => {
    expect(opensApp(signedIn, { vaultOnDevice: false })).toBe(true);
  });

  it('opens the kept vault when only the network kept the session away', () => {
    expect(opensApp(offline, { vaultOnDevice: true })).toBe(true);
    expect(opensApp(offline, { vaultOnDevice: false })).toBe(false);
  });

  it('shows the sign-in for any other way of being signed out, or while checking', () => {
    expect(opensApp(signedOut, { vaultOnDevice: true })).toBe(false);
    expect(opensApp(revoked, { vaultOnDevice: true })).toBe(false);
    expect(opensApp({ status: 'checking' }, { vaultOnDevice: true })).toBe(false);
  });

  it('tries the session again only when the network was the reason', () => {
    expect(waitsForNetwork(offline)).toBe(true);
    expect(waitsForNetwork(signedOut)).toBe(false);
    expect(waitsForNetwork(signedIn)).toBe(false);
  });
});
