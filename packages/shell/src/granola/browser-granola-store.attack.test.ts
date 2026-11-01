// @vitest-environment jsdom
// Adversarial probes for PR #156 (P28-12). Diagnose only: a red test here is a defect.
import { afterEach, describe, expect, it } from 'vitest';
import { browserGranolaPullRecords } from './browser-granola-store.ts';
import { clockTime } from '../sync/sync-view.ts';

const VAULT = '/Users/mara/Vault';

afterEach(() => window.localStorage.clear());

describe('browserGranolaPullRecords, attacked', () => {
  it('ATTACK: a hand-edited lastPullAt past the range of a date reads as none, not "Invalid Date" on the card', () => {
    window.localStorage.setItem(
      `atlas.granola-pull:${VAULT}`,
      JSON.stringify({ watermark: null, lastPullAt: 1e300 }),
    );
    const { lastPullAt } = browserGranolaPullRecords.read(VAULT);
    // The card shows `Last pulled at ${clockTime(lastPullAt)}`.
    const shown = lastPullAt === null ? null : clockTime(lastPullAt);
    expect(shown).not.toBe('Invalid Date');
  });

  it('probe: storage holding JSON null, an array or a string reads as none', () => {
    for (const kept of ['null', '[]', '"x"', '{}']) {
      window.localStorage.setItem(`atlas.granola-pull:${VAULT}`, kept);
      expect(browserGranolaPullRecords.read(VAULT)).toEqual({ watermark: null, lastPullAt: null });
    }
  });
});
