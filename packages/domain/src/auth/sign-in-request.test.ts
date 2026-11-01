import { describe, expect, it } from 'vitest';
import {
  base64url,
  isWellFormedSignInSecret,
  newPendingSignIn,
  SIGN_IN_SECRET_BYTES,
} from './sign-in-request.ts';

/** #663, ADR-0052: the state and PKCE verifier a sign-in starts with. */

const bytes = (...values: number[]) => Uint8Array.from(values);
/** A seeded, repeatable stand-in for secure random bytes. */
const seeded = (seed: number, count = SIGN_IN_SECRET_BYTES) =>
  Uint8Array.from({ length: count }, (_, i) => (seed * 31 + i * 17) & 0xff);

describe('base64url', () => {
  it.each([
    [bytes(), ''],
    [bytes(0x66), 'Zg'],
    [bytes(0x66, 0x6f), 'Zm8'],
    [bytes(0x66, 0x6f, 0x6f), 'Zm9v'],
    [bytes(0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72), 'Zm9vYmFy'],
    // The two characters base64 and base64url differ on, and no padding.
    [bytes(0xfb, 0xff), '-_8'],
  ])('encodes %o as %s (RFC 4648 vectors)', (input, expected) => {
    expect(base64url(input)).toBe(expected);
  });

  it('encodes as Node does, for every length up to a few blocks', () => {
    for (let length = 0; length < 20; length += 1) {
      const input = seeded(length, length);
      expect(base64url(input)).toBe(Buffer.from(input).toString('base64url'));
    }
  });

  it('gives RFC 7636’s challenge for its example verifier’s SHA-256', () => {
    // RFC 7636 appendix B: SHA-256 of "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".
    const digest = Uint8Array.from(
      Buffer.from('13d31e961a1ad8ec2f16b10c4c982e0876a878ad6df144566ee1894acb70f9c3', 'hex'),
    );
    expect(base64url(digest)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('a new pending sign-in', () => {
  it('holds a 43-character state and verifier from its draws, and when it started', () => {
    const pending = newPendingSignIn({
      stateBytes: seeded(1),
      verifierBytes: seeded(2),
      now: 1000,
    });
    expect(pending.state).toHaveLength(43);
    expect(pending.verifier).toHaveLength(43);
    expect(pending.state).not.toBe(pending.verifier);
    expect(isWellFormedSignInSecret(pending.state)).toBe(true);
    expect(isWellFormedSignInSecret(pending.verifier)).toBe(true);
    expect(pending.startedAt).toBe(1000);
  });

  it('refuses a short draw for either secret', () => {
    const short = seeded(3, SIGN_IN_SECRET_BYTES - 1);
    expect(() => newPendingSignIn({ stateBytes: short, verifierBytes: seeded(2), now: 0 })).toThrow(
      /32 random bytes/,
    );
    expect(() => newPendingSignIn({ stateBytes: seeded(1), verifierBytes: short, now: 0 })).toThrow(
      /32 random bytes/,
    );
  });
});

describe('a well-formed secret', () => {
  it('is 43 to 128 of RFC 7636’s unreserved characters', () => {
    expect(isWellFormedSignInSecret('a'.repeat(43))).toBe(true);
    expect(isWellFormedSignInSecret('A-._~9'.repeat(21) + 'xx')).toBe(true);
    expect(isWellFormedSignInSecret('a'.repeat(42))).toBe(false);
    expect(isWellFormedSignInSecret('a'.repeat(129))).toBe(false);
    expect(isWellFormedSignInSecret('a'.repeat(42) + '+')).toBe(false);
    expect(isWellFormedSignInSecret('a'.repeat(42) + '&')).toBe(false);
  });
});
