import { REFRESH_MARGIN_MS } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import {
  countingRandom,
  fakeAuthGateway,
  fakeSha256,
  memoryPendingSignIn,
} from '../testing/fake-auth.ts';
import { createAuthService } from './auth-service.ts';

/**
 * #663, PR #704's third attack: sign-out while a refresh hangs. Nothing in
 * the browser bounds the refresh's fetch (postJson has no timeout), so a
 * refresh on a captive or dropped network can stay in flight for minutes.
 * Sign-out waits for it before ending the session here, so the person who
 * pressed Sign out on a shared iPad is left looking at their vault.
 */

const START = Date.UTC(2026, 9, 31, 9, 0, 0);
const HOUR = 60 * 60_000;

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('sign-out while a refresh hangs', () => {
  it.fails(
    'ends the session in this tab at once, without waiting for the hung refresh',
    async () => {
      let now = START;
      const gateway = fakeAuthGateway();
      const pending = memoryPendingSignIn();
      const auth = createAuthService({
        gateway,
        pending,
        random: countingRandom(),
        sha256: fakeSha256,
        clock: { now: () => now },
      });
      await auth.signIn();
      gateway.codes.add('good-code');
      await auth.restore(`?code=good-code&state=${pending.held?.state ?? ''}`);
      expect(auth.state().status).toBe('signed-in');

      // Into the refresh margin; the refresh's fetch never comes back.
      now += 8 * HOUR - REFRESH_MARGIN_MS + 1;
      gateway.holdRefreshes = true;
      void auth.tokenForRequest().catch(() => undefined);
      await settle();

      void auth.signOut();
      await settle();

      // Observed: still 'signed-in' until the hung fetch lands, however long that is.
      expect(auth.state().status).toBe('signed-out');
    },
  );
});
