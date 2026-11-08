import { describe, expect, it } from 'vitest';
import { tagFilter } from './e2e-tags.ts';

/** Whether a run with `filter` keeps a test whose title and tags read `titled`. */
function keeps(filter: ReturnType<typeof tagFilter>, titled: string): boolean {
  if (filter.grep !== undefined && !filter.grep.test(titled)) return false;
  return filter.grepInvert === undefined || !filter.grepInvert.test(titled);
}

describe('which tagged e2e tests a run leaves out', () => {
  const gateOnLinux = tagFilter({ platform: 'linux', quarantinedOnly: false });
  const gateOnMac = tagFilter({ platform: 'darwin', quarantinedOnly: false });
  const quarantineOnLinux = tagFilter({ platform: 'linux', quarantinedOnly: true });
  const quarantineOnMac = tagFilter({ platform: 'darwin', quarantinedOnly: true });

  it('runs an untagged test everywhere but the quarantine run', () => {
    expect(keeps(gateOnLinux, 'saves a note')).toBe(true);
    expect(keeps(gateOnMac, 'saves a note')).toBe(true);
    expect(keeps(quarantineOnLinux, 'saves a note')).toBe(false);
  });

  it('leaves a quarantined test out of the gate, on any platform', () => {
    expect(keeps(gateOnLinux, 'saves a note @quarantine')).toBe(false);
    expect(keeps(gateOnMac, 'saves a note @quarantine')).toBe(false);
  });

  it('runs only quarantined tests in the quarantine run', () => {
    expect(keeps(quarantineOnLinux, 'saves a note @quarantine')).toBe(true);
    expect(keeps(quarantineOnMac, 'saves a note @quarantine')).toBe(true);
  });

  it('still leaves macOS-only tests out off a Mac, quarantined or not', () => {
    expect(keeps(gateOnLinux, 'transposes @mac')).toBe(false);
    expect(keeps(quarantineOnLinux, 'transposes @mac @quarantine')).toBe(false);
    expect(keeps(gateOnMac, 'transposes @mac')).toBe(true);
    expect(keeps(quarantineOnMac, 'transposes @mac @quarantine')).toBe(true);
  });

  it('does not take a longer tag for the quarantine one', () => {
    expect(keeps(gateOnLinux, 'saves a note @quarantined-elsewhere')).toBe(true);
  });

  it('leaves nothing out on a Mac but the quarantined, or the rest in a quarantine run', () => {
    expect(gateOnMac.grep).toBeUndefined();
    expect(quarantineOnMac.grepInvert).toBeUndefined();
  });
});
