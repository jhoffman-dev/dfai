import type { PlatformCapabilities, PlatformCapability } from '@dfai/domain';

/** One thing DFAI cannot do where it runs, in the person's words, and why not (#670). */
export interface PlatformLimit {
  /** What cannot be done here, as a person would name it. */
  readonly what: string;
  /** Why not, and where it can be done instead. */
  readonly why: string;
}

/**
 * What each capability's absence means to the person. `null` for saving as a
 * commit: it is one of two ways to save, and a platform lacking it saves the
 * other way (by git), so there is nothing the person misses. `null` too for
 * Markdown export, which every platform has: as files, or a download (#774).
 *
 * Settings → Not available here and the Field Guide's section on the web are
 * both drawn from this one table, so they say the same thing. Listed in the
 * capability map's order (a test holds it), and read by its keys, so this
 * file imports only types: the guide's build runs it under plain Node.
 */
const LIMITS: Readonly<Record<PlatformCapability, PlatformLimit | null>> = {
  syncByGit: {
    what: 'Syncing by git',
    why: 'Each save goes to GitHub as a commit of its own instead; there is no copy of the vault on this device to pull and push.',
  },
  saveAsCommit: null,
  fileWatching: {
    what: 'Seeing a change made elsewhere the moment it lands',
    why: 'A change from another device shows up the next time DFAI reads that note or folder from GitHub.',
  },
  localFolderVault: {
    what: 'Opening a folder on this device as a vault',
    why: 'A web page cannot open folders; it reads and writes the GitHub repository you signed in to.',
  },
  repoCreation: {
    what: 'Making a new repository for a vault',
    why: 'DFAI may reach only the repository you gave it on GitHub; make a new one on GitHub or in the desktop app.',
  },
  localModels: {
    what: 'Related notes and search by meaning',
    why: 'They come from a model the desktop app runs on the computer; there is none to run here.',
  },
  claudeCodeChat: {
    what: 'The Claude chat, and rules with a Claude step',
    why: 'They run Claude Code, installed on the computer the desktop app runs on.',
  },
  heldSecrets: {
    what: 'Secrets: the keys feeds and the model API use',
    why: 'Only the desktop app can keep a key where the page itself cannot read it.',
  },
  webFetch: {
    what: 'Refreshing a source from a feed or a web page',
    why: 'A web page may not fetch other sites on your behalf; refresh it in the desktop app.',
  },
  googleCalendar: {
    what: 'Google Calendar: today’s meetings and time blocks',
    why: 'The Google sign-in is kept by the desktop app, out of the page’s reach.',
  },
  granola: {
    what: 'Importing meetings from Granola',
    why: 'Granola’s key is a secret only the desktop app can keep.',
  },
  slack: {
    what: 'Capturing Slack messages into the Inbox',
    why: 'Slack’s token is a secret only the desktop app can keep.',
  },
  kindle: {
    what: 'Kindle highlights',
    why: 'They are read from Amazon in a window the desktop app keeps for them.',
  },
  globalCapture: {
    what: 'Quick capture from anywhere',
    why: 'A web page cannot set a shortcut that works in every other app.',
  },
  localApi: {
    what: 'The local API and the MCP server',
    why: 'They answer other programs on the same computer; a web page cannot run a server.',
  },
  sqliteSources: {
    what: 'Sources read from another program’s SQLite file',
    why: 'A web page cannot read another program’s files.',
  },
  markdownExport: null,
  googleDriveExport: {
    what: 'Exporting a note as a Google Doc',
    why: 'It goes through the Google sign-in the desktop app keeps.',
  },
  pdfExport: {
    what: 'Exporting a note as a PDF',
    why: 'The PDF is made by the desktop app.',
  },
  pageThumbnails: {
    what: 'Pictures of an artifact’s first screen on its card',
    why: 'They are taken by the desktop app.',
  },
};

/**
 * What a platform with `capabilities` cannot do, in the capability map's
 * order, for saying so in Settings and the guide. Empty where nothing a
 * person would miss is lacking, as on the desktop.
 */
export function platformLimits(capabilities: PlatformCapabilities): readonly PlatformLimit[] {
  return (Object.keys(LIMITS) as PlatformCapability[]).flatMap((name) => {
    const limit = LIMITS[name];
    return capabilities[name] || limit === null ? [] : [limit];
  });
}
