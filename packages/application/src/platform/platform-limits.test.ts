import { describe, expect, it } from 'vitest';
import {
  capabilitiesLacking,
  DESKTOP_CAPABILITIES,
  PLATFORM_CAPABILITIES,
  WEB_CAPABILITIES,
  type PlatformCapabilities,
} from '@dfai/domain';
import { platformLimits } from './platform-limits.ts';

const EVERYTHING = Object.fromEntries(
  PLATFORM_CAPABILITIES.map((name) => [name, true]),
) as PlatformCapabilities;

describe('what a platform cannot do, in the person’s words (#670)', () => {
  it('names nothing on the desktop, whose one lack is a way of saving it has another of', () => {
    expect(capabilitiesLacking(DESKTOP_CAPABILITIES)).toEqual(['saveAsCommit']);
    expect(platformLimits(DESKTOP_CAPABILITIES)).toEqual([]);
  });

  it('names nothing where every capability is on', () => {
    expect(platformLimits(EVERYTHING)).toEqual([]);
  });

  it('names one limit for each capability the web lacks, in the map’s order', () => {
    const lacking = capabilitiesLacking(WEB_CAPABILITIES);
    const limits = platformLimits(WEB_CAPABILITIES);
    expect(limits).toHaveLength(lacking.length);
    expect(limits[0]?.what).toBe('Syncing by git');
    expect(limits.map((limit) => limit.what)).toContain('The local API and the MCP server');
    expect(limits.at(-1)?.what).toBe('Pictures of an artifact’s first screen on its card');
  });

  it.each(PLATFORM_CAPABILITIES.filter((name) => name !== 'saveAsCommit'))(
    'says what is missing, and why, when %s is off',
    (name) => {
      const [limit, ...more] = platformLimits({ ...EVERYTHING, [name]: false });
      expect(more).toEqual([]);
      expect(limit?.what.trim()).not.toBe('');
      expect(limit?.why.trim()).not.toBe('');
    },
  );

  it('lists them in the capability map’s order, whichever are off', () => {
    const one = (name: (typeof PLATFORM_CAPABILITIES)[number]) =>
      platformLimits({ ...EVERYTHING, [name]: false });
    const none = Object.fromEntries(
      PLATFORM_CAPABILITIES.map((name) => [name, false]),
    ) as PlatformCapabilities;
    expect(platformLimits(none)).toEqual(PLATFORM_CAPABILITIES.flatMap(one));
  });

  it('gives every limit a name of its own, so a list of them reads without repeats', () => {
    const none = Object.fromEntries(
      PLATFORM_CAPABILITIES.map((name) => [name, false]),
    ) as PlatformCapabilities;
    const names = platformLimits(none).map((limit) => limit.what);
    expect(names).toHaveLength(PLATFORM_CAPABILITIES.length - 1);
    expect(new Set(names).size).toBe(names.length);
  });
});
