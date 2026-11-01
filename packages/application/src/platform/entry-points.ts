import type {
  AutomationDraft,
  Datasource,
  ExportFormat,
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
  /** Settings → Claude. */
  claudeSettings: ['claudeCodeChat'],
  /** The chat: the aside's Claude tab, its toggle, ⇧⌘J, and Ask (its other seat). */
  claudeChat: ['claudeCodeChat'],
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
} as const satisfies Record<string, readonly PlatformCapability[]>;

export type EntryPoint = keyof typeof NEEDS;

/** Whether the screen offers each entry point. Every one is named, so none is forgotten. */
export type EntryPointsOffered = Readonly<Record<EntryPoint, boolean>>;

/** Every entry point, in the order they are listed. */
export const ENTRY_POINTS = Object.freeze(Object.keys(NEEDS) as EntryPoint[]);

/** The capabilities an entry point needs, every one of them. */
export function capabilitiesNeeded(entry: EntryPoint): readonly PlatformCapability[] {
  return NEEDS[entry];
}

/** Which entry points a platform with `capabilities` offers: those whose every capability it has. */
export function entryPointsOffered(capabilities: PlatformCapabilities): EntryPointsOffered {
  return Object.freeze(
    Object.fromEntries(
      ENTRY_POINTS.map((entry) => [entry, NEEDS[entry].every((name) => capabilities[name])]),
    ),
  ) as EntryPointsOffered;
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
