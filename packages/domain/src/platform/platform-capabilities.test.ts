import { describe, expect, it } from 'vitest';
import {
  capabilitiesLacking,
  DESKTOP_CAPABILITIES,
  PLATFORM_CAPABILITIES,
  WEB_CAPABILITIES,
  type PlatformCapabilities,
} from './platform-capabilities.ts';

/** #655, ADR-0051: what the desktop and the web build can do, as the UI reads it. */

const platforms: [string, PlatformCapabilities][] = [
  ['desktop', DESKTOP_CAPABILITIES],
  ['web', WEB_CAPABILITIES],
];

describe('the platform capabilities', () => {
  it('are each named once', () => {
    expect(new Set(PLATFORM_CAPABILITIES).size).toBe(PLATFORM_CAPABILITIES.length);
  });

  it.each(platforms)('on the %s say yes or no to every capability and nothing else', (_, value) => {
    expect(Object.keys(value).sort()).toEqual([...PLATFORM_CAPABILITIES].sort());
    expect(Object.values(value).every((answer) => typeof answer === 'boolean')).toBe(true);
  });

  it.each(platforms)('on the %s cannot be changed by whoever reads them', (_, value) => {
    expect(Object.isFrozen(value)).toBe(true);
  });

  it.each(platforms)('on the %s keep a vault in step one way, never both', (_, value) => {
    expect(value.syncByGit).not.toBe(value.saveAsCommit);
  });
});

describe('the desktop', () => {
  it('syncs by git and lacks only saving a note as a commit', () => {
    expect(DESKTOP_CAPABILITIES.syncByGit).toBe(true);
    expect(capabilitiesLacking(DESKTOP_CAPABILITIES)).toEqual(['saveAsCommit']);
  });
});

describe('the web build', () => {
  it('saves each note as a commit instead of syncing by git', () => {
    expect(WEB_CAPABILITIES.saveAsCommit).toBe(true);
    expect(WEB_CAPABILITIES.syncByGit).toBe(false);
  });

  it('keeps Markdown export, as a download', () => {
    expect(WEB_CAPABILITIES.markdownExport).toBe(true);
  });
});

describe('the capabilities a platform lacks', () => {
  const allBut = (...lacking: string[]): PlatformCapabilities =>
    Object.fromEntries(
      PLATFORM_CAPABILITIES.map((name) => [name, !lacking.includes(name)]),
    ) as PlatformCapabilities;

  it('are none when it has them all', () => {
    expect(capabilitiesLacking(allBut())).toEqual([]);
  });

  it('come in the order the capabilities are listed, whatever order they were named in', () => {
    expect(capabilitiesLacking(allBut('pageThumbnails', 'kindle', 'syncByGit'))).toEqual([
      'syncByGit',
      'kindle',
      'pageThumbnails',
    ]);
  });
});
