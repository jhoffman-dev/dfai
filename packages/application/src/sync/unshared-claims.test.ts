import { describe, expect, it, vi } from 'vitest';
import type { AutomationsOnGitHub } from './automations-on-github.ts';
import type { AutomationsSettingsNow } from './sync-settings.ts';
import { createUnsharedClaims } from './unshared-claims.ts';

const VAULT = '/Users/j/Notes';
const LAPTOP = 'mac-laptop';
const here = (automationsMac: string | null): AutomationsSettingsNow => ({
  reading:
    automationsMac === null || automationsMac === LAPTOP ? 'names-this-mac' : 'names-another-mac',
  automationsMac,
  automationsMacName: null,
});
const studioOnGitHub: AutomationsOnGitHub = {
  automationsMac: 'mac-studio',
  automationsMacName: 'Studio',
};
const laptopOnGitHub: AutomationsOnGitHub = {
  automationsMac: LAPTOP,
  automationsMacName: 'Laptop',
};

function claimsReading(github: () => Promise<AutomationsOnGitHub>) {
  const onChange = vi.fn();
  const onGitHub = vi.fn(async () => github());
  return { claims: createUnsharedClaims({ onGitHub, onChange }), onChange, onGitHub };
}

describe('createUnsharedClaims: a claim judged from git (#630 attack)', () => {
  it('finds a claim here that GitHub does not have, after a restart forgot it', async () => {
    const { claims } = claimsReading(async () => studioOnGitHub);
    await expect(
      claims.learn({ vault: VAULT, here: here(LAPTOP), thisMacId: LAPTOP, pushed: false }),
    ).resolves.toBe(true);
    expect(claims.unshared(VAULT)).toBe(true);
    expect(claims.was(VAULT)).toBe('Studio');
  });

  it('is shared once GitHub names this Mac too, and says so once', async () => {
    let github = studioOnGitHub;
    const { claims, onChange } = claimsReading(async () => github);
    await claims.learn({ vault: VAULT, here: here(LAPTOP), thisMacId: LAPTOP, pushed: false });
    github = laptopOnGitHub;
    await claims.learn({ vault: VAULT, here: here(LAPTOP), thisMacId: LAPTOP, pushed: true });
    await claims.learn({ vault: VAULT, here: here(LAPTOP), thisMacId: LAPTOP, pushed: true });
    expect(claims.unshared(VAULT)).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('counts a claim as not shared when GitHub’s settings cannot be read: nothing runs on a guess', async () => {
    const { claims } = claimsReading(async () => {
      throw new Error('fatal: bad object');
    });
    await expect(
      claims.learn({ vault: VAULT, here: here(LAPTOP), thisMacId: LAPTOP, pushed: true }),
    ).resolves.toBe(true);
  });

  it('reads GitHub only where the settings here name this Mac', async () => {
    const { claims, onGitHub } = claimsReading(async () => studioOnGitHub);
    await expect(
      claims.learn({ vault: VAULT, here: here('mac-studio'), thisMacId: LAPTOP, pushed: false }),
    ).resolves.toBe(false);
    await claims.learn({ vault: VAULT, here: here(null), thisMacId: LAPTOP, pushed: false });
    expect(onGitHub).not.toHaveBeenCalled();
  });

  it('judges a claim written since the pull from what GitHub said at it', async () => {
    const { claims } = claimsReading(async () => studioOnGitHub);
    // The pull: the settings here named Studio, so GitHub was not read.
    await claims.learn({
      vault: VAULT,
      here: here('mac-studio'),
      thisMacId: LAPTOP,
      pushed: false,
    });
    expect(claims.judge(VAULT, here(LAPTOP), LAPTOP)).toBe(true);
    expect(claims.unshared(VAULT)).toBe(true);
  });

  it('judges a named Mac whose claim GitHub has as shared', async () => {
    const { claims } = claimsReading(async () => laptopOnGitHub);
    await claims.learn({ vault: VAULT, here: here(LAPTOP), thisMacId: LAPTOP, pushed: false });
    expect(claims.judge(VAULT, here(LAPTOP), LAPTOP)).toBe(false);
  });

  it('marks a claim at its write, and keeps it by vault', () => {
    const { claims } = claimsReading(async () => studioOnGitHub);
    claims.claimed(VAULT, 'Studio');
    expect(claims.unshared(VAULT)).toBe(true);
    expect(claims.unshared('/Users/j/Other')).toBe(false);
    expect(claims.judge(VAULT, here(LAPTOP), LAPTOP)).toBe(true);
  });

  describe('without git to read', () => {
    const claims = () => createUnsharedClaims({ onGitHub: null, onChange: () => undefined });

    it('takes a completed sync to have pushed it, and a look not', async () => {
      const known = claims();
      known.claimed(VAULT, 'Studio');
      await expect(
        known.learn({ vault: VAULT, here: here(LAPTOP), thisMacId: LAPTOP, pushed: false }),
      ).resolves.toBe(true);
      await expect(
        known.learn({ vault: VAULT, here: here(LAPTOP), thisMacId: LAPTOP, pushed: true }),
      ).resolves.toBe(false);
    });

    it('judges by what this session wrote alone', () => {
      expect(claims().judge(VAULT, here(LAPTOP), LAPTOP)).toBe(false);
    });
  });
});
