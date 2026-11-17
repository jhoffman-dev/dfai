import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_PRESETS,
  createVaultPath,
  DESKTOP_CAPABILITIES,
  EVERY_FEATURE_ON,
  FEATURES,
  featureOfPlace,
  featuresOn,
  PLATFORM_CAPABILITIES,
  WEB_CAPABILITIES,
  type AutomationDraft,
  type FeatureId,
  type PagePlace,
  type PlatformCapabilities,
  type PlatformCapability,
} from '@dfai/domain';
import {
  capabilitiesNeeded,
  ENTRY_POINTS,
  entryPointsOffered,
  EVERY_ENTRY_POINT,
  exportFormatsOffered,
  featureOfEntry,
  NEEDS_THE_DESKTOP_APP,
  offeredWithFeatures,
  pageOffered,
  presetsOffered,
  ruleHeldByPlatform,
  sourceRefreshOffered,
  type EntryPoint,
  type EntryPointsOffered,
} from './entry-points.ts';

/** Every capability on, saving as a commit among them. */
const EVERYTHING = Object.fromEntries(
  PLATFORM_CAPABILITIES.map((name) => [name, true]),
) as PlatformCapabilities;

const without = (name: PlatformCapability): PlatformCapabilities => ({
  ...EVERYTHING,
  [name]: false,
});

/** The entry points no platform lacks: those only a feature's switch can hide (#901). */
const NEEDS_NOTHING = ENTRY_POINTS.filter((entry) => capabilitiesNeeded(entry).length === 0);

const hidden = (capabilities: PlatformCapabilities): EntryPoint[] => {
  const offered = entryPointsOffered(capabilities);
  return ENTRY_POINTS.filter((entry) => !offered[entry]);
};

/**
 * What each capability's absence hides, written out by hand rather than read
 * back from the map, so a capability moved to another entry point shows here.
 * A capability with no entry point of its own works out of sight: watching the
 * vault, and saving as a commit.
 */
const HIDES: Readonly<Record<PlatformCapability, readonly EntryPoint[]>> = {
  syncByGit: [
    'syncSettings',
    'syncLight',
    'backgroundSync',
    'newSyncRepository',
    'openVaultFromGitHub',
  ],
  saveAsCommit: [],
  fileWatching: [],
  localFolderVault: ['chooseVaultFolder', 'openVaultFromGitHub', 'overwriteConflict'],
  repoCreation: ['newSyncRepository'],
  localModels: ['meaningSearch'],
  claudeCodeChat: ['claudeSettings', 'claudeChat', 'skillDraft', 'claudeAutomations'],
  heldSecrets: ['secretsSettings'],
  webFetch: ['webSourceRefresh'],
  googleCalendar: ['googleCalendarSettings', 'meetingSync', 'blockSync'],
  granola: ['granolaSettings', 'granolaPull'],
  slack: ['slackSettings', 'slackLinkOffer'],
  kindle: ['kindleSettings', 'kindleCommands'],
  globalCapture: ['globalCaptureSettings', 'globalCaptureShortcut'],
  localApi: ['connectionsSettings', 'localApiServer'],
  sqliteSources: ['sqliteSourceRefresh'],
  markdownExport: ['exportNotes', 'pdfExport', 'googleDocExport'],
  googleDriveExport: ['googleDocExport'],
  pdfExport: ['pdfExport'],
  pageThumbnails: ['regenerateThumbnail'],
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

  it('hides on the web what its missing capabilities need: all but Markdown export and what needs none (#774)', () => {
    const offered = entryPointsOffered(WEB_CAPABILITIES);
    expect(ENTRY_POINTS.filter((entry) => offered[entry])).toEqual(
      ENTRY_POINTS.filter((entry) => entry === 'exportNotes' || NEEDS_NOTHING.includes(entry)),
    );
  });

  it('hides every entry point that needs a capability when none is on', () => {
    const none = Object.fromEntries(
      PLATFORM_CAPABILITIES.map((name) => [name, false]),
    ) as PlatformCapabilities;
    expect(hidden(none)).toEqual(ENTRY_POINTS.filter((entry) => !NEEDS_NOTHING.includes(entry)));
  });
});

describe('entryPointsOffered, with the features switched off (#901)', () => {
  /**
   * What switching each feature off hides, written out by hand rather than
   * read back from the map, so an entry point moved to another feature shows here.
   */
  const HIDES_WHEN_OFF: Readonly<Record<FeatureId, readonly EntryPoint[]>> = {
    reading: ['libraryPages', 'documentReader', 'addDocuments'],
  };

  const hiddenBy = (off: readonly FeatureId[]): EntryPoint[] => {
    const offered = entryPointsOffered(EVERYTHING, featuresOn(off));
    return ENTRY_POINTS.filter((entry) => !offered[entry]);
  };

  it('offers everything the platform can while every feature is on, as before', () => {
    expect(entryPointsOffered(EVERYTHING, EVERY_FEATURE_ON)).toEqual(EVERY_ENTRY_POINT);
    expect(entryPointsOffered(DESKTOP_CAPABILITIES, featuresOn([]))).toEqual(EVERY_ENTRY_POINT);
  });

  it.each(FEATURES.map((feature) => feature.id))(
    'hides what belongs to %s, and only that, when it is off',
    (id) => {
      expect(HIDES_WHEN_OFF[id].length).toBeGreaterThan(0);
      expect(hiddenBy([id]).sort()).toEqual([...HIDES_WHEN_OFF[id]].sort());
    },
  );

  it('names, for each entry point, the feature it belongs to', () => {
    for (const entry of ENTRY_POINTS) {
      const owner = FEATURES.find((feature) => HIDES_WHEN_OFF[feature.id].includes(entry));
      expect(featureOfEntry(entry)).toBe(owner?.id ?? null);
    }
  });

  it('never offers what the platform lacks because a feature is on', () => {
    const lacking = { ...EVERY_ENTRY_POINT, documentReader: false };
    expect(offeredWithFeatures(lacking, EVERY_FEATURE_ON).documentReader).toBe(false);
  });

  it('answers the object it was handed when no switch takes anything away', () => {
    const platform = entryPointsOffered(DESKTOP_CAPABILITIES);
    expect(offeredWithFeatures(platform, EVERY_FEATURE_ON)).toBe(platform);
    const readingAlreadyOff = {
      ...platform,
      ...Object.fromEntries(HIDES_WHEN_OFF.reading.map((entry) => [entry, false])),
    } as EntryPointsOffered;
    expect(offeredWithFeatures(readingAlreadyOff, featuresOn(['reading']))).toBe(readingAlreadyOff);
  });

  it('answers a frozen object of its own when a switch takes something away', () => {
    const platform = entryPointsOffered(DESKTOP_CAPABILITIES);
    const offered = offeredWithFeatures(platform, featuresOn(['reading']));
    expect(offered).not.toBe(platform);
    expect(Object.isFrozen(offered)).toBe(true);
    expect(platform.libraryPages).toBe(true);
  });
});

describe('pageOffered (#901)', () => {
  const pdf = createVaultPath('Library/The Lantern Keepers.pdf');
  const readingPages: PagePlace[] = [
    { kind: 'library' },
    { kind: 'highlights' },
    { kind: 'document', path: pdf },
  ];

  it("hides Reading's pages while it is off, the pages the domain says are Reading's", () => {
    const offered = entryPointsOffered(DESKTOP_CAPABILITIES, featuresOn(['reading']));
    expect(readingPages.map(featureOfPlace)).toEqual(['reading', 'reading', 'reading']);
    expect(readingPages.map((place) => pageOffered(place, offered))).toEqual([false, false, false]);
  });

  it('offers every page while every feature is on', () => {
    const offered = entryPointsOffered(DESKTOP_CAPABILITIES);
    expect(readingPages.map((place) => pageOffered(place, offered))).toEqual([true, true, true]);
  });

  it('offers a page no switch hides, whatever is off', () => {
    const offered = entryPointsOffered(DESKTOP_CAPABILITIES, featuresOn(['reading']));
    expect(featureOfPlace({ kind: 'today' })).toBeNull();
    expect(pageOffered({ kind: 'today' }, offered)).toBe(true);
    expect(pageOffered({ kind: 'tags', tag: null }, offered)).toBe(true);
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

  it('offers only Markdown where neither PDF nor Google Drive is', () => {
    const markdownOnly = { ...EVERYTHING, pdfExport: false, googleDriveExport: false };
    expect(exportFormatsOffered(entryPointsOffered(markdownOnly))).toEqual([
      'markdown',
      'standalone',
    ]);
  });

  it('offers only the Markdown formats on the web, as a download (#774)', () => {
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

describe('presetsOffered', () => {
  const names = (presets: readonly { name: string }[]) => presets.map((preset) => preset.name);

  it('offers every preset on the desktop', () => {
    const desktop = entryPointsOffered(DESKTOP_CAPABILITIES);
    expect(names(presetsOffered(AUTOMATION_PRESETS, desktop))).toEqual(names(AUTOMATION_PRESETS));
  });

  it('offers on the web only the presets that ask no Claude, in their order', () => {
    const web = entryPointsOffered(WEB_CAPABILITIES);
    const offered = presetsOffered(AUTOMATION_PRESETS, web);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((preset) => preset.action.kind !== 'claude')).toBe(true);
    expect(names(offered)).toEqual(
      names(AUTOMATION_PRESETS.filter((preset) => preset.action.kind !== 'claude')),
    );
    expect(names(offered)).not.toContain('Morning brief');
  });
});

describe('ruleHeldByPlatform', () => {
  const asking = {
    action: {
      kind: 'claude',
      prompt: createVaultPath('.atlas/prompts/Triage.md'),
      tools: [],
      output: { kind: 'proposals', schema: 'proposals' },
    },
  } satisfies Pick<AutomationDraft, 'action'>;
  const archiving = { action: { kind: 'archive' } } satisfies Pick<AutomationDraft, 'action'>;

  it('holds a rule with a Claude step where there is no Claude Code, saying why', () => {
    const web = entryPointsOffered(WEB_CAPABILITIES);
    expect(ruleHeldByPlatform(asking, web)).toBe(NEEDS_THE_DESKTOP_APP);
    expect(ruleHeldByPlatform(archiving, web)).toBeNull();
  });

  it('holds nothing on the desktop', () => {
    const desktop = entryPointsOffered(DESKTOP_CAPABILITIES);
    expect(ruleHeldByPlatform(asking, desktop)).toBeNull();
    expect(ruleHeldByPlatform(archiving, desktop)).toBeNull();
  });
});
