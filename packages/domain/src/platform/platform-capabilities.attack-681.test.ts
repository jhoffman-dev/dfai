import { describe, expect, it } from 'vitest';
import {
  capabilitiesLacking,
  DESKTOP_CAPABILITIES,
  PLATFORM_CAPABILITIES,
  WEB_CAPABILITIES,
} from './platform-capabilities';
import type { PlatformCapabilities } from './platform-capabilities';

/** Attack tests for PR #681. An `it.fails` is a gap that is real today. */
describe('attack #681: platform capabilities', () => {
  it('lists the lacking capabilities in list order for every single-capability gap', () => {
    for (const name of PLATFORM_CAPABILITIES) {
      const value = { ...DESKTOP_CAPABILITIES, saveAsCommit: true, [name]: false };
      expect(capabilitiesLacking(value)).toEqual([name]);
    }
  });

  it('ignores a key that is not a capability', () => {
    const value = { ...WEB_CAPABILITIES, teleport: false } as PlatformCapabilities;
    expect(capabilitiesLacking(value)).toEqual(capabilitiesLacking(WEB_CAPABILITIES));
  });

  it('counts a capability missing from a value read from storage as lacking', () => {
    const partial: Partial<Record<string, boolean>> = { ...DESKTOP_CAPABILITIES };
    delete partial.kindle;
    expect(capabilitiesLacking(partial as PlatformCapabilities)).toContain('kindle');
  });

  it('gives every platform a way to save: by git or as a commit', () => {
    for (const value of [DESKTOP_CAPABILITIES, WEB_CAPABILITIES]) {
      expect(value.syncByGit || value.saveAsCommit).toBe(true);
    }
  });

  // `as const` is type-only: at runtime the list is a plain array that any
  // caller can push to or reorder, changing every platform value built after
  // and the order capabilitiesLacking reports in. The values are frozen; the
  // list they are built from is not.
  it.fails('freezes the capability list itself', () => {
    expect(Object.isFrozen(PLATFORM_CAPABILITIES)).toBe(true);
  });

  it('hands back a list the caller can change without changing the next answer', () => {
    capabilitiesLacking(WEB_CAPABILITIES).push('kindle');
    expect(capabilitiesLacking(DESKTOP_CAPABILITIES)).toEqual(['saveAsCommit']);
  });
});
