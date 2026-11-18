import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_PRESETS,
  createVaultPath,
  DESKTOP_CAPABILITIES,
  EVERY_FEATURE_ON,
  FEATURES,
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
  STARTS_WORK,
  workOffered,
  featureOfPage,
  pageTurnedOff,
  presetsOffered,
  ruleHeldByPlatform,
  sourceRefreshOffered,
  type EntryPoint,
  type EntryPointsOffered,
  type WorkEntry,
  type WorkOffered,
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
  claudeCodeChat: [
    'claudeSettings',
    'claudeChat',
    'chatWork',
    'inboxSuggest',
    'skillDraft',
    'claudeAutomations',
  ],
  heldSecrets: ['secretsSettings'],
  webFetch: ['webSourceRefresh'],
  googleCalendar: ['googleCalendarSettings', 'meetingSync', 'blockSync'],
  granola: ['granolaSettings', 'granolaPull'],
  slack: ['slackSettings', 'slackLinkOffer'],
  kindle: ['kindleSettings', 'kindleCommands', 'kindleSync'],
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
    kindle: ['kindleSettings', 'kindleCommands', 'kindleSync'],
    // Settings → Claude, Suggest, Skills' Ask Claude… and rules' Claude steps stay (ADR-0055).
    ask: ['claudeChat', 'chatWork'],
    graph: ['graphPage'],
    slack: ['slackSettings', 'slackLinkOffer'],
  };

  /** A feature and every feature that requires it, all the way down: what switching it off takes. */
  const withDependents = (id: FeatureId): FeatureId[] =>
    FEATURES.filter((feature) => !featuresOn([id])[feature.id]).map((feature) => feature.id);

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
      const expected = withDependents(id).flatMap((off) => HIDES_WHEN_OFF[off]);
      expect(hiddenBy([id]).sort()).toEqual(expected.sort());
    },
  );

  it('hides Kindle with Reading, and Reading alone with Kindle', () => {
    expect(withDependents('reading')).toEqual(['reading', 'kindle']);
    expect(hiddenBy(['reading'])).toEqual(expect.arrayContaining([...HIDES_WHEN_OFF.kindle]));
    expect(hiddenBy(['kindle'])).not.toEqual(expect.arrayContaining([...HIDES_WHEN_OFF.reading]));
  });

  it('keeps what other features reach Claude by when Ask is off', () => {
    const offered = entryPointsOffered(EVERYTHING, featuresOn(['ask']));
    expect(offered.claudeChat).toBe(false);
    expect(offered).toMatchObject({
      claudeSettings: true,
      inboxSuggest: true,
      skillDraft: true,
      claudeAutomations: true,
    });
  });

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
      ...Object.fromEntries(
        withDependents('reading').flatMap((id) =>
          HIDES_WHEN_OFF[id].map((entry) => [entry, false]),
        ),
      ),
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

describe('workOffered: work that starts by itself waits for the settings (#901)', () => {
  /** Written out by hand, so an entry point added to or taken from the work shows here. */
  const HELD: readonly WorkEntry[] = ['kindleSync', 'slackLinkOffer', 'chatWork'];
  const held = (working: WorkOffered) => [...STARTS_WORK].filter((entry) => !working[entry]);

  it('holds, until the settings answer, every runner, timer and listener of a feature with a switch', () => {
    expect([...STARTS_WORK].sort()).toEqual([...HELD].sort());
    expect(held(workOffered(EVERY_ENTRY_POINT, { answered: false })).sort()).toEqual(
      [...HELD].sort(),
    );
  });

  it('holds only what a switch could stop: every entry point it holds belongs to a feature', () => {
    for (const entry of STARTS_WORK) expect(featureOfEntry(entry)).not.toBeNull();
  });

  it('classifies every entry point a switch can take away, as drawn or as work', () => {
    const switchable = ENTRY_POINTS.filter((entry) => featureOfEntry(entry) !== null);
    const drawn = switchable.filter((entry) => !STARTS_WORK.has(entry as WorkEntry));
    // What is drawn shows at once, and is never in the work held for the settings.
    for (const entry of ['claudeChat', 'graphPage', 'libraryPages', 'kindleCommands'] as const) {
      expect(drawn).toContain(entry);
    }
    expect(drawn.length + STARTS_WORK.size).toBe(switchable.length);
  });

  it('answers the very object it was handed once the settings have answered', () => {
    const offered = entryPointsOffered(DESKTOP_CAPABILITIES, featuresOn(['graph']));
    expect(workOffered(offered, { answered: true })).toBe(offered);
  });

  it('answers one frozen object for each object held, and never offers what was not', () => {
    const lacking = entryPointsOffered(WEB_CAPABILITIES);
    const first = workOffered(lacking, { answered: false });
    expect(workOffered(lacking, { answered: false })).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.chatWork).toBe(false);
    const answered = workOffered(lacking, { answered: true });
    for (const entry of STARTS_WORK) expect(first[entry] && !answered[entry]).toBe(false);
  });
});

describe('pageTurnedOff and featureOfPage (#901)', () => {
  const pdf = createVaultPath('Library/The Lantern Keepers.pdf');
  const readingPages: PagePlace[] = [
    { kind: 'library' },
    { kind: 'highlights' },
    { kind: 'document', path: pdf },
  ];
  /** Each switchable page beyond Reading's, with the feature it belongs to. */
  const otherPages: readonly (readonly [PagePlace, FeatureId])[] = [
    [{ kind: 'ask' }, 'ask'],
    [{ kind: 'graph', scope: { kind: 'vault' } }, 'graph'],
    [{ kind: 'graph', scope: { kind: 'note', path: pdf, depth: 1 } }, 'graph'],
  ];

  /** Whether `place` shows the notice with `off` switched off, on a platform with `capabilities`. */
  const turnedOff = (
    place: PagePlace,
    off: readonly FeatureId[],
    capabilities: PlatformCapabilities = DESKTOP_CAPABILITIES,
  ) =>
    pageTurnedOff(place, {
      offered: entryPointsOffered(capabilities, featuresOn(off)),
      platform: entryPointsOffered(capabilities),
    });

  it.each(otherPages)(
    'names the feature of %o, and hides it only while that is off',
    (place, id) => {
      expect(featureOfPage(place)).toBe(id);
      expect(turnedOff(place, [id])).toBe(id);
      expect(turnedOff(place, [])).toBeNull();
      const others = FEATURES.map((feature) => feature.id).filter((other) => other !== id);
      expect(turnedOff(place, others)).toBeNull();
    },
  );

  it('names Reading for its pages, and hides them while it is off', () => {
    expect(readingPages.map(featureOfPage)).toEqual(['reading', 'reading', 'reading']);
    expect(readingPages.map((place) => turnedOff(place, ['reading']))).toEqual([
      'reading',
      'reading',
      'reading',
    ]);
  });

  it('draws every page while every feature is on', () => {
    expect(readingPages.map((place) => turnedOff(place, []))).toEqual([null, null, null]);
  });

  it('draws a page no switch hides, whatever is off', () => {
    for (const place of [{ kind: 'today' }, { kind: 'tags', tag: null }] as const) {
      expect(featureOfPage(place)).toBeNull();
      expect(turnedOff(place, ['reading'])).toBeNull();
    }
  });

  it('blames no switch for a page the platform does not offer: Ask on the web is drawn as before', () => {
    const ask: PagePlace = { kind: 'ask' };
    expect(entryPointsOffered(WEB_CAPABILITIES).claudeChat).toBe(false);
    expect(turnedOff(ask, [], WEB_CAPABILITIES)).toBeNull();
    expect(turnedOff(ask, ['ask'], WEB_CAPABILITIES)).toBeNull();
    // Where the platform has it, the switch alone decides.
    expect(turnedOff(ask, ['ask'])).toBe('ask');
    // The Graph needs nothing of the platform: its switch is the reason on the web too.
    expect(
      turnedOff({ kind: 'graph', scope: { kind: 'vault' } }, ['graph'], WEB_CAPABILITIES),
    ).toBe('graph');
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
