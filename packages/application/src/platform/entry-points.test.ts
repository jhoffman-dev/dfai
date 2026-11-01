import { describe, expect, it } from 'vitest';
import {
  DESKTOP_CAPABILITIES,
  PLATFORM_CAPABILITIES,
  WEB_CAPABILITIES,
  type PlatformCapabilities,
  type PlatformCapability,
} from '@dfai/domain';
import {
  ENTRY_POINTS,
  entryPointsOffered,
  EVERY_ENTRY_POINT,
  exportFormatsOffered,
  sourceRefreshOffered,
  type EntryPoint,
} from './entry-points.ts';

/** Every capability on, saving as a commit among them. */
const EVERYTHING = Object.fromEntries(
  PLATFORM_CAPABILITIES.map((name) => [name, true]),
) as PlatformCapabilities;

const without = (name: PlatformCapability): PlatformCapabilities => ({
  ...EVERYTHING,
  [name]: false,
});

const hidden = (capabilities: PlatformCapabilities): EntryPoint[] => {
  const offered = entryPointsOffered(capabilities);
  return ENTRY_POINTS.filter((entry) => !offered[entry]);
};

/**
 * What each capability's absence hides, written out by hand rather than read
 * back from the map, so a capability moved to another entry point shows here.
 * A capability with no entry point of its own works out of sight: watching the
 * vault, saving as a commit, and an artifact card's picture (which keeps its
 * placeholder, ADR-0051).
 */
const HIDES: Readonly<Record<PlatformCapability, readonly EntryPoint[]>> = {
  syncByGit: ['syncSettings', 'syncLight', 'newSyncRepository', 'openVaultFromGitHub'],
  saveAsCommit: [],
  fileWatching: [],
  localFolderVault: ['chooseVaultFolder', 'openVaultFromGitHub'],
  repoCreation: ['newSyncRepository'],
  localModels: ['meaningSearch'],
  claudeCodeChat: ['claudeSettings', 'claudeChat'],
  heldSecrets: ['secretsSettings'],
  webFetch: ['webSourceRefresh'],
  googleCalendar: ['googleCalendarSettings'],
  granola: ['granolaSettings'],
  slack: ['slackSettings', 'slackLinkOffer'],
  kindle: ['kindleSettings', 'kindleCommands'],
  globalCapture: ['globalCaptureSettings'],
  localApi: ['connectionsSettings'],
  sqliteSources: ['sqliteSourceRefresh'],
  markdownExport: ['exportNotes', 'pdfExport', 'googleDocExport'],
  googleDriveExport: ['googleDocExport'],
  pdfExport: ['pdfExport'],
  pageThumbnails: [],
};

describe('entryPointsOffered', () => {
  it.each(PLATFORM_CAPABILITIES)('hides what needs %s, and only that, when it is off', (name) => {
    expect(hidden(without(name)).sort()).toEqual([...HIDES[name]].sort());
  });

  it('offers every entry point on the desktop: nothing it shows today goes', () => {
    expect(entryPointsOffered(DESKTOP_CAPABILITIES)).toEqual(EVERY_ENTRY_POINT);
    expect(hidden(DESKTOP_CAPABILITIES)).toEqual([]);
  });

  it('offers every entry point when every capability is on', () => {
    expect(entryPointsOffered(EVERYTHING)).toEqual(EVERY_ENTRY_POINT);
  });

  it('hides on the web what its missing capabilities need, keeping export as Markdown', () => {
    const offered = entryPointsOffered(WEB_CAPABILITIES);
    expect(ENTRY_POINTS.filter((entry) => offered[entry])).toEqual(['exportNotes']);
  });

  it('hides every entry point when no capability is on', () => {
    const none = Object.fromEntries(
      PLATFORM_CAPABILITIES.map((name) => [name, false]),
    ) as PlatformCapabilities;
    expect(hidden(none)).toEqual(ENTRY_POINTS);
  });
});

describe('exportFormatsOffered', () => {
  it('offers every format on the desktop', () => {
    expect(exportFormatsOffered(entryPointsOffered(DESKTOP_CAPABILITIES))).toEqual([
      'markdown',
      'standalone',
      'pdf',
      'google-doc',
    ]);
  });

  it('offers only Markdown on the web', () => {
    expect(exportFormatsOffered(entryPointsOffered(WEB_CAPABILITIES))).toEqual([
      'markdown',
      'standalone',
    ]);
  });

  it('drops the PDF and the Doc each with its own capability', () => {
    expect(exportFormatsOffered(entryPointsOffered(without('pdfExport')))).toEqual([
      'markdown',
      'standalone',
      'google-doc',
    ]);
    expect(exportFormatsOffered(entryPointsOffered(without('googleDriveExport')))).toEqual([
      'markdown',
      'standalone',
      'pdf',
    ]);
  });

  it('offers none without Markdown export', () => {
    expect(exportFormatsOffered(entryPointsOffered(without('markdownExport')))).toEqual([]);
  });
});

describe('sourceRefreshOffered', () => {
  const web = entryPointsOffered(WEB_CAPABILITIES);
  const desktop = entryPointsOffered(DESKTOP_CAPABILITIES);
  const feed = { url: 'https://example.com/feed.json', format: 'json' } as const;
  const database = { url: null, format: 'sqlite' } as const;
  const vaultFile = { url: null, format: 'csv' } as const;

  it('offers every refresh on the desktop', () => {
    expect(
      [feed, database, vaultFile].map((source) => sourceRefreshOffered(source, desktop)),
    ).toEqual([true, true, true]);
  });

  it('on the web, refreshes only a source reading a file in the vault', () => {
    expect([feed, database, vaultFile].map((source) => sourceRefreshOffered(source, web))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('asks for the web by a fetch, whatever its format', () => {
    const sqliteOff = entryPointsOffered(without('sqliteSources'));
    expect(
      sourceRefreshOffered({ url: 'https://example.com/x', format: 'sqlite' }, sqliteOff),
    ).toBe(true);
  });
});
