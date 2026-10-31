import { describe, expect, it } from 'vitest';
import { settingsSectionLinks } from './settings-sections.ts';

/** Attack on PR #371 (slice 13f): the written-down list of the app's Settings sections. */
describe('settingsSectionLinks, attack 371', () => {
  const ids = (vaultOpen: boolean) => settingsSectionLinks({ vaultOpen }).map((s) => s.id);

  it('lists no section twice, with a vault or without', () => {
    for (const vaultOpen of [true, false]) {
      expect(new Set(ids(vaultOpen)).size).toBe(ids(vaultOpen).length);
    }
  });

  it('without a vault, is the with-vault list minus some, in the same order', () => {
    const withVault = ids(true);
    const without = ids(false);
    const kept = withVault.filter((id) => without.includes(id));
    expect(kept).toEqual(without);
    expect(without.length).toBeLessThan(withVault.length);
  });

  it('never lists the dialog’s own sections, which it draws first itself', () => {
    for (const vaultOpen of [true, false]) {
      expect(ids(vaultOpen)).not.toContain('settings-appearance');
      expect(ids(vaultOpen)).not.toContain('settings-connections');
    }
  });
});
