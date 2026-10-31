/**
 * What a platform DFAI runs on can do (#655, ADR-0051). The screen asks this,
 * never "am I on the web?": a feature a platform lacks is hidden because the
 * capability is missing, so a new platform is one more value, not a new
 * branch in every component (#657).
 *
 * Each name is one thing the person can see or use, not one host command:
 * ADR-0051 maps every command to the capability it serves, and each one the
 * web lacks is served by at least one command absent there.
 *
 * The platform values live here, beside the list, rather than in each app's
 * composition: they are policy (what the web build is), and the rules across
 * them, such as every platform having one way to save, are tested in one place.
 */
export const PLATFORM_CAPABILITIES = Object.freeze([
  /** The vault is a git clone, pulled and pushed in the background (ADR-0025). */
  'syncByGit',
  /** Each save is a commit through the GitHub API, refused when the note moved. */
  'saveAsCommit',
  /** A change made to the vault by another app shows up without a reload. */
  'fileWatching',
  /** Any folder on disk can be opened, or a repository cloned into one, as a vault. */
  'localFolderVault',
  /** A new private repository can be made to hold a vault. */
  'repoCreation',
  /** Embeddings made by a model run on the device: related notes and meaning search. */
  'localModels',
  /** The chat runs Claude Code installed on the device. */
  'claudeCodeChat',
  /** Secrets kept out of the page's reach, filled in as a request leaves (feeds, the model API). */
  'heldSecrets',
  /** Fetching a feed or a page from outside the vault. */
  'webFetch',
  /** Today's meetings and time blocks through a Google sign-in the host keeps. */
  'googleCalendar',
  /** Meeting notes imported from Granola. */
  'granola',
  /** Slack messages captured into the Inbox. */
  'slack',
  /** Kindle highlights read from the notebook in a session of its own (ADR-0044). */
  'kindle',
  /** One system-wide shortcut that opens quick capture from any app (ADR-0033). */
  'globalCapture',
  /** The local HTTP API and the MCP server other programs on the device call (ADR-0016). */
  'localApi',
  /** Another program's SQLite file read as a source. */
  'sqliteSources',
  /** A note exported as Markdown files. */
  'markdownExport',
  /** A note exported to Google Drive, under the Google sign-in the host keeps. */
  'googleDriveExport',
  /** A note exported as a PDF. */
  'pdfExport',
  /** A picture of an artifact's first screen for its card. */
  'pageThumbnails',
] as const);

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

/** Whether the platform has each capability. Every capability is named, so none is forgotten. */
export type PlatformCapabilities = Readonly<Record<PlatformCapability, boolean>>;

function capabilitiesWithout(lacking: readonly PlatformCapability[]): PlatformCapabilities {
  const absent = new Set(lacking);
  return Object.freeze(
    Object.fromEntries(PLATFORM_CAPABILITIES.map((name) => [name, !absent.has(name)])),
  ) as PlatformCapabilities;
}

/**
 * The macOS app, the one desktop build there is. It has everything, saving a
 * note as a commit aside: it syncs by git instead. Windows gets a value of its
 * own when it ships (#673), since Kindle, thumbnails and PDFs are macOS code.
 */
export const DESKTOP_CAPABILITIES: PlatformCapabilities = capabilitiesWithout(['saveAsCommit']);

/**
 * The web build (the iPad PWA): a GitHub repository read and written through
 * the GitHub API, notes cached as they are used, and no host to keep a secret,
 * run a process or reach the system (ADR-0051).
 */
export const WEB_CAPABILITIES: PlatformCapabilities = capabilitiesWithout([
  'syncByGit',
  'fileWatching',
  'localFolderVault',
  'repoCreation',
  'localModels',
  'claudeCodeChat',
  'heldSecrets',
  'webFetch',
  'googleCalendar',
  'granola',
  'slack',
  'kindle',
  'globalCapture',
  'localApi',
  'sqliteSources',
  'googleDriveExport',
  'pdfExport',
  'pageThumbnails',
]);

/** The capabilities a platform lacks, in the order they are listed, for saying what it cannot do. */
export function capabilitiesLacking(capabilities: PlatformCapabilities): PlatformCapability[] {
  return PLATFORM_CAPABILITIES.filter((name) => !capabilities[name]);
}
