import { describe, expect, it } from 'vitest';
import { quarantineMode, tagFilter } from './e2e-tags.ts';

/** Whether a run with `filter` keeps a test whose title and tags read `titled`. */
function keeps(filter: ReturnType<typeof tagFilter>, titled: string): boolean {
  if (filter.grep !== undefined && !filter.grep.test(titled)) return false;
  return filter.grepInvert === undefined || !filter.grepInvert.test(titled);
}

describe('which tagged e2e tests a run leaves out', () => {
  const gateOnLinux = tagFilter({ platform: 'linux', quarantine: 'leave-out' });
  const gateOnMac = tagFilter({ platform: 'darwin', quarantine: 'leave-out' });
  const quarantineOnLinux = tagFilter({ platform: 'linux', quarantine: 'only' });
  const quarantineOnMac = tagFilter({ platform: 'darwin', quarantine: 'only' });
  const listedOnLinux = tagFilter({ platform: 'linux', quarantine: 'list' });

  it('runs an untagged test everywhere but the quarantine runs', () => {
    expect(keeps(gateOnLinux, 'saves a note')).toBe(true);
    expect(keeps(gateOnMac, 'saves a note')).toBe(true);
    expect(keeps(quarantineOnLinux, 'saves a note')).toBe(false);
    expect(keeps(listedOnLinux, 'saves a note')).toBe(false);
  });

  it('leaves a quarantined test out of the gate, on any platform', () => {
    expect(keeps(gateOnLinux, 'saves a note @quarantine')).toBe(false);
    expect(keeps(gateOnMac, 'saves a note @quarantine')).toBe(false);
  });

  it('runs only quarantined tests in the quarantine run', () => {
    expect(keeps(quarantineOnLinux, 'saves a note @quarantine')).toBe(true);
    expect(keeps(quarantineOnMac, 'saves a note @quarantine')).toBe(true);
  });

  it('runs a macOS-only quarantined test on a Mac, and lists it off one, so it is not lost', () => {
    expect(keeps(quarantineOnLinux, 'transposes @mac @quarantine')).toBe(false);
    expect(keeps(quarantineOnMac, 'transposes @mac @quarantine')).toBe(true);
    expect(keeps(listedOnLinux, 'transposes @mac @quarantine')).toBe(true);
  });

  it('still leaves macOS-only tests out of the gate off a Mac', () => {
    expect(keeps(gateOnLinux, 'transposes @mac')).toBe(false);
    expect(keeps(gateOnMac, 'transposes @mac')).toBe(true);
  });

  it('does not take a longer tag for the quarantine one', () => {
    expect(keeps(gateOnLinux, 'saves a note @quarantined-elsewhere')).toBe(true);
  });
});

describe('the quarantine mode E2E_QUARANTINE asks for', () => {
  it.each([
    ['only', 'only'],
    ['list', 'list'],
    [undefined, 'leave-out'],
    ['', 'leave-out'],
    ['yes', 'leave-out'],
  ] as const)('%s is %s', (fromEnv, mode) => {
    expect(quarantineMode(fromEnv)).toBe(mode);
  });
});
