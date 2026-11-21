// Types only: the guide's build runs this file under plain Node (`tools/guide/build-guide.ts`).
import type {
  AutomationDraft,
  Datasource,
  ExportFormat,
  FeatureId,
  FeaturesOn,
  PagePlace,
  PlatformCapabilities,
  PlatformCapability,
} from '@dfai/domain';

/**
 * Every place the screen offers a feature some platform lacks, and every
 * runner that works for one out of sight, with the capabilities each needs
 * (#657, ADR-0051). The screen reads which of these are offered and never
 * asks which platform it is on: a platform lacking a capability loses each
 * entry point that needs it, and nothing else.
 *
 * Deleting is on every platform, so it has no entry here.
 */
const NEEDS = {
  /** Settings → Connections: the local API's switch, its token and the MCP command. */
  connectionsSettings: ['localApi'],
  /** The local API's server, answering other programs on the device. */
  localApiServer: ['localApi'],
  /** Settings → Quick capture from anywhere: the system-wide shortcut. */
  globalCaptureSettings: ['globalCapture'],
  /** The system-wide shortcut, registered as the app starts and heard after. */
  globalCaptureShortcut: ['globalCapture'],
  /** Settings → Secrets: what feeds and the model API send, kept out of the page. */
  secretsSettings: ['heldSecrets'],
  /** Settings → Google Calendar. */
  googleCalendarSettings: ['googleCalendar'],
  /** Today's meetings read from the calendar, on their own clock. */
  meetingSync: ['googleCalendar'],
  /** Settings → Google Calendar's meetings: their switch, calendars and Sync now. */
  meetingSyncSettings: ['googleCalendar'],
  /** Time blocks written to and read from their calendar, on their own clock. */
  blockSync: ['googleCalendar'],
  /** Settings → Granola. */
  granolaSettings: ['granola'],
  /** Granola's meetings pulled as the vault opens and on their clock, and its key asked after. */
  granolaPull: ['granola'],
  /** Settings → Slack. */
  slackSettings: ['slack'],
  /** A pasted Slack link offered for saving, under the editor or in quick capture. */
  slackLinkOffer: ['slack'],
  /** Settings → Kindle. */
  kindleSettings: ['kindle'],
  /** ⌘K's Connect Kindle, Sync Kindle now and Disconnect Kindle. */
  kindleCommands: ['kindle'],
  /** Kindle's highlights synced as the index is ready and every four hours, and a sync asked for. */
  kindleSync: ['kindle'],
  /** Settings → Claude. */
  claudeSettings: ['claudeCodeChat'],
  /** The chat: the aside's Claude tab, its toggle, ⇧⌘J, and Ask (its other seat). */
  claudeChat: ['claudeCodeChat'],
  /** The chat's own work for a seat on screen: whether Claude can be reached, the window's context, a turn. */
  chatWork: ['claudeCodeChat'],
  /**
   * The Inbox's Suggest, which asks Claude where each item goes (#900): an
   * Inbox function that reaches Claude as a rule's step does, not Ask's.
   */
  inboxSuggest: ['claudeCodeChat'],
  /** Skills' "Ask Claude…", which drafts a skill. */
  skillDraft: ['claudeCodeChat'],
  /**
   * Rules with a Claude step: the editor's "Ask Claude" action, the meeting
   * set-up that installs such rules, and the runner carrying them out.
   */
  claudeAutomations: ['claudeCodeChat'],
  /** Settings → Sync. */
  syncSettings: ['syncByGit'],
  /** The sidebar's sync light, which opens Settings → Sync. */
  syncLight: ['syncByGit'],
  /** The sync runner: the repository looked at as the vault opens, and the pulls and pushes after. */
  backgroundSync: ['syncByGit'],
  /** Settings → Sync's "create a new private repository". */
  newSyncRepository: ['syncByGit', 'repoCreation'],
  /** "Choose folder…" and "Open another folder…": a folder on disk as the vault. */
  chooseVaultFolder: ['localFolderVault'],
  /** "Open a vault from GitHub…": a clone into a folder on disk, synced by git. */
  openVaultFromGitHub: ['localFolderVault', 'syncByGit'],
  /** ⌘K's "By meaning" and a note's related notes, from a model run on the device. */
  meaningSearch: ['localModels'],
  /** ⌘K's and the note's "Export…", whose first formats are Markdown. */
  exportNotes: ['markdownExport'],
  /** Export's PDF format. */
  pdfExport: ['markdownExport', 'pdfExport'],
  /** Export's Google Doc format. */
  googleDocExport: ['markdownExport', 'googleDriveExport'],
  /** A source note's Refresh, for a source that fetches from outside the vault. */
  webSourceRefresh: ['webFetch'],
  /** A source note's Refresh and Choose file, for a source reading another program's SQLite file. */
  sqliteSourceRefresh: ['sqliteSources'],
  /** An artifact's Regenerate, and the queue picturing its first screen for its card. */
  regenerateThumbnail: ['pageThumbnails'],
  /**
   * A refused save's Overwrite the file: only where the vault is a folder on
   * this device. On the web (#667) it would replace, unseen, what a Mac
   * committed; keeping this text as a copy, or discarding it, loses nothing.
   */
  overwriteConflict: ['localFolderVault'],
  // Reading's surfaces (#901): on every platform, each behind the person's switch alone.
  /** The Library and All highlights: their sidebar rows, ⌘K's commands and their pages. */
  libraryPages: [],
  /** A PDF or EPUB in the reader, however it is reached: Pages, a link, a highlight, a kept tab. */
  documentReader: [],
  /** ⌘K's Add PDF… and Add EPUB…. */
  addDocuments: [],
  /** The graph: its sidebar row, its page, and a note's Show in graph. */
  graphPage: [],
  /** The Automations page and its sidebar row: the rules, their editor, Run now, dry runs and presets. */
  automationsPage: [],
  /**
   * The rules run by themselves: on their schedule, on opening the vault and
   * on a note's news, with the prompts refreshed and the rules taken in.
   */
  automationsRunner: [],
  /** Meetings that arrive by pull, checked, deduplicated and marked (P28-04), on the automations Mac. */
  meetingImport: [],
} as const satisfies Record<string, readonly PlatformCapability[]>;

export type EntryPoint = keyof typeof NEEDS;

/**
 * The key feature each entry point belongs to, where the person can switch
 * it off in Settings → Features (#901, ADR-0055): offered then means the
 * platform can, and the person wants it. Every entry point says, so a new one
 * cannot be left out by accident; null follows the platform alone.
 */
const FEATURE_OF = {
  connectionsSettings: null,
  localApiServer: null,
  globalCaptureSettings: null,
  globalCaptureShortcut: null,
  secretsSettings: null,
  // Settings → Google Calendar holds the sign-in that time blocks share (ADR-0030):
  // only its meetings part is Meetings', and block sync follows the platform alone.
  googleCalendarSettings: null,
  meetingSync: 'meetings',
  meetingSyncSettings: 'meetings',
  blockSync: null,
  granolaSettings: 'meetings',
  granolaPull: 'meetings',
  slackSettings: 'slack',
  slackLinkOffer: 'slack',
  kindleSettings: 'kindle',
  kindleCommands: 'kindle',
  kindleSync: 'kindle',
  // Settings → Claude stays with Ask off: its provider and model are what
  // Suggest, Skills' Ask Claude… and rules' Claude steps reach Claude by.
  claudeSettings: null,
  claudeChat: 'ask',
  chatWork: 'ask',
  // Suggest is the Inbox's, not a rule's: it stays with Automations off, as with Ask off.
  inboxSuggest: null,
  skillDraft: null,
  claudeAutomations: 'automations',
  syncSettings: null,
  syncLight: null,
  backgroundSync: null,
  newSyncRepository: null,
  chooseVaultFolder: null,
  openVaultFromGitHub: null,
  meaningSearch: null,
  exportNotes: null,
  pdfExport: null,
  googleDocExport: null,
  webSourceRefresh: null,
  sqliteSourceRefresh: null,
  regenerateThumbnail: null,
  overwriteConflict: null,
  libraryPages: 'reading',
  documentReader: 'reading',
  addDocuments: 'reading',
  graphPage: 'graph',
  automationsPage: 'automations',
  automationsRunner: 'automations',
  meetingImport: 'meetings',
} as const satisfies Readonly<Record<EntryPoint, FeatureId | null>>;

/** The entry points a switch in Settings → Features can take away. */
type SwitchableEntry = {
  [Entry in EntryPoint]: (typeof FEATURE_OF)[Entry] extends null ? never : Entry;
}[EntryPoint];

/**
 * What each entry point of a switchable feature is (#901): `'draws'` — a row,
 * a command, a page, a Settings section — or `'work'`, which starts by itself:
 * a runner, a timer, a listener, a call to the network. Every one says, so an
 * entry point given a feature in `FEATURE_OF` does not compile until it is
 * classified here, and a runner cannot be left out of the settings wait by
 * forgetting it.
 *
 * Until the vault's settings have answered, the off list is not known, so
 * the work is held (`workOffered`): a feature the file switches off never
 * starts, and one it leaves on starts once the answer is in. What draws is
 * not held, so the chrome shows at once.
 */
const KIND_OF = {
  slackSettings: 'draws',
  slackLinkOffer: 'work',
  kindleSettings: 'draws',
  kindleCommands: 'draws',
  kindleSync: 'work',
  claudeChat: 'draws',
  chatWork: 'work',
  libraryPages: 'draws',
  documentReader: 'draws',
  addDocuments: 'draws',
  graphPage: 'draws',
  // The editor's Ask Claude, the meeting set-up's offer and the presets with a Claude step:
  // what runs them is `automationsRunner`.
  claudeAutomations: 'draws',
  automationsPage: 'draws',
  automationsRunner: 'work',
  meetingSyncSettings: 'draws',
  meetingSync: 'work',
  granolaSettings: 'draws',
  granolaPull: 'work',
  meetingImport: 'work',
} as const satisfies Readonly<Record<SwitchableEntry, 'draws' | 'work'>>;

/** The entry points of a switchable feature that start work by themselves, which wait for the settings. */
export type WorkEntry = {
  [Entry in SwitchableEntry]: (typeof KIND_OF)[Entry] extends 'work' ? Entry : never;
}[SwitchableEntry];

/** The work entry points, held until the vault's settings answer: built from `KIND_OF`, never by hand. */
export const STARTS_WORK: ReadonlySet<WorkEntry> = new Set(
  (Object.keys(KIND_OF) as SwitchableEntry[]).filter(
    (entry): entry is WorkEntry => KIND_OF[entry] === 'work',
  ),
);

/**
 * The entry point each page a switch can hide is drawn under, by the page's
 * kind: the one table from a place to its feature, through `FEATURE_OF`.
 */
const PAGE_ENTRY: Partial<Record<PagePlace['kind'], EntryPoint>> = {
  library: 'libraryPages',
  highlights: 'libraryPages',
  document: 'documentReader',
  ask: 'claudeChat',
  graph: 'graphPage',
  automations: 'automationsPage',
};

/** Whether the screen offers each entry point. Every one is named, so none is forgotten. */
export type EntryPointsOffered = Readonly<Record<EntryPoint, boolean>>;

declare const WORK_SWITCH: unique symbol;

/**
 * Whether one piece of work of a switchable feature may start, as only
 * `workOffered` hands it out (#920): a boolean the runners take for their
 * `enabled`, so one cannot be fed from `offered.*` — which does not wait for
 * the vault's settings — or from a literal. Tests make one with `workSwitch`
 * from the test support, and only there.
 */
export type WorkSwitch = boolean & { readonly [WORK_SWITCH]: true };

/**
 * Whether each piece of work of a switchable feature may start: only the work
 * entries, each a `WorkSwitch`, so a runner's `enabled` is read from what
 * waits for the settings, and a row's or a page's cannot be.
 */
export type WorkOffered = { readonly [Entry in WorkEntry]: WorkSwitch };

/** Every entry point, in the order they are listed. */
export const ENTRY_POINTS = Object.freeze(Object.keys(NEEDS) as EntryPoint[]);

/** The capabilities an entry point needs, every one of them. */
export function capabilitiesNeeded(entry: EntryPoint): readonly PlatformCapability[] {
  return NEEDS[entry];
}

/** The feature an entry point belongs to, or null when no switch hides it. */
export function featureOfEntry(entry: EntryPoint): FeatureId | null {
  const feature: FeatureId | null = FEATURE_OF[entry];
  return feature;
}

/**
 * Which entry points a platform with `capabilities` offers, with the features
 * `on` the person has on: those whose every capability it has, and whose
 * feature is on. Left out, every feature is on.
 */
export function entryPointsOffered(
  capabilities: PlatformCapabilities,
  on?: FeaturesOn,
): EntryPointsOffered {
  const platform = Object.freeze(
    Object.fromEntries(
      ENTRY_POINTS.map((entry) => [entry, NEEDS[entry].every((name) => capabilities[name])]),
    ),
  ) as EntryPointsOffered;
  return on === undefined ? platform : offeredWithFeatures(platform, on);
}

/**
 * What the platform offers, less each entry point whose feature is off: the
 * one place the person's switches reach the screen. With nothing taken away
 * it answers `offered` itself, so a window with every feature on keeps the
 * very object it was handed.
 */
export function offeredWithFeatures(
  offered: EntryPointsOffered,
  on: FeaturesOn,
): EntryPointsOffered {
  const off = ENTRY_POINTS.filter((entry) => {
    const feature = FEATURE_OF[entry];
    return offered[entry] && feature !== null && !on[feature];
  });
  if (off.length === 0) return offered;
  return Object.freeze({
    ...offered,
    ...Object.fromEntries(off.map((entry) => [entry, false])),
  });
}

/** Each object held, by the object it came from: the same `offered` is always held as the same object. */
const heldUntilAnswered = new WeakMap<EntryPointsOffered, EntryPointsOffered>();

/**
 * What work that starts by itself may start: `offered` once the vault's
 * settings have answered, and until then `offered` with every `STARTS_WORK`
 * entry point held. Work reads this, never `offered`; a failed read still
 * answers, so nothing is held for ever.
 */
export function workOffered(
  offered: EntryPointsOffered,
  { answered }: { answered: boolean },
): WorkOffered {
  let held = offered;
  if (!answered) {
    held = heldUntilAnswered.get(offered) ?? heldFor(offered);
    heldUntilAnswered.set(offered, held);
  }
  // The one place a WorkSwitch is made: each work entry, as waited for here.
  return held as unknown as WorkOffered;
}

/** `offered` with every work entry held off. */
function heldFor(offered: EntryPointsOffered): EntryPointsOffered {
  return Object.freeze({
    ...offered,
    ...Object.fromEntries([...STARTS_WORK].map((entry) => [entry, false])),
  });
}

/**
 * The switched-off feature a page belongs to, when its entry point is not
 * offered for that: what a tab kept on it shows a notice for in place of the
 * page. Null for a page that is drawn, and for one whose entry point the
 * platform itself does not offer, whatever the switch says: the notice's
 * "Turn on in Settings" could not bring that back, so the page is drawn as
 * it always was there.
 */
export function pageTurnedOff(
  place: PagePlace,
  { offered, platform }: { offered: EntryPointsOffered; platform: EntryPointsOffered },
): FeatureId | null {
  const entry = PAGE_ENTRY[place.kind];
  if (entry === undefined || offered[entry] || !platform[entry]) return null;
  return FEATURE_OF[entry];
}

/** The feature whose page a place is, on or off: null for a page no switch can hide. */
export function featureOfPage(place: PagePlace): FeatureId | null {
  const entry = PAGE_ENTRY[place.kind];
  return entry === undefined ? null : FEATURE_OF[entry];
}

/** Every entry point offered, as a platform with every capability has them. */
export const EVERY_ENTRY_POINT: EntryPointsOffered = Object.freeze(
  Object.fromEntries(ENTRY_POINTS.map((entry) => [entry, true])),
) as EntryPointsOffered;

/** The export formats offered, in the order the export dialog lists them. */
export function exportFormatsOffered(offered: EntryPointsOffered): readonly ExportFormat[] {
  if (!offered.exportNotes) return [];
  return [
    'markdown',
    'standalone',
    ...(offered.pdfExport ? (['pdf'] as const) : []),
    ...(offered.googleDocExport ? (['google-doc'] as const) : []),
  ];
}

/**
 * Whether a source note's Refresh is offered: a fetch needs the web, another
 * program's SQLite file needs the device, and a file in the vault needs neither.
 */
export function sourceRefreshOffered(
  source: Pick<Datasource, 'url' | 'format'>,
  offered: EntryPointsOffered,
): boolean {
  if (source.url !== null) return offered.webSourceRefresh;
  if (source.format === 'sqlite') return offered.sqliteSourceRefresh;
  return true;
}

/** What a rule the platform cannot carry out says, in place of failing at each tick. */
export const NEEDS_THE_DESKTOP_APP =
  'Needs the desktop app: its Claude step runs Claude Code there.';

/**
 * Why a rule cannot run on this platform, or null when it can: a Claude step
 * needs Claude Code on the device, so where there is none the rule is held,
 * not run and failed (#657).
 */
export function ruleHeldByPlatform(
  rule: Pick<AutomationDraft, 'action'>,
  offered: EntryPointsOffered,
): string | null {
  return rule.action.kind === 'claude' && !offered.claudeAutomations ? NEEDS_THE_DESKTOP_APP : null;
}

/**
 * The presets a platform offers, in their order: only those it could run, so
 * no preset writes a rule here that would only ever be held (#657).
 */
export function presetsOffered<Preset extends Pick<AutomationDraft, 'action'>>(
  presets: readonly Preset[],
  offered: EntryPointsOffered,
): readonly Preset[] {
  return presets.filter((preset) => ruleHeldByPlatform(preset, offered) === null);
}
