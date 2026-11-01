import webPackage from '../package.json' with { type: 'json' };
import { staticAppInfo } from '@dfai/adapters';
import { WEB_CAPABILITIES } from '@dfai/domain';
import {
  browserClipboard,
  browserGlobalCaptureStore,
  browserGranolaPullRecords,
  browserMacId,
  browserSyncPause,
  type AppPorts,
  type ShellComposition,
} from '@dfai/shell';
import { sampleVault } from './sample-vault.ts';
import { sessionActivityStore, sessionSyncFiles } from './session-stores.ts';
import {
  NO_CLAUDE,
  NO_GIT,
  NO_GIT_FOLDERS,
  NO_GITHUB,
  NO_GLOBAL_CAPTURE,
  NO_GOOGLE_CALENDAR,
  NO_GRANOLA,
  NO_LOCAL_API,
  NO_SLACK,
  NO_SOURCES,
  notYet,
} from './not-yet-ports.ts';

/** The web build as the shell is handed it: its ports, and what a browser can do (#657). */
export function composeWebShell(): ShellComposition {
  return { ports: composeWeb(), capabilities: WEB_CAPABILITIES };
}

/**
 * The web's composition root, as a stub (#656): the shared shell on the
 * sample vault, kept for the page's session, with every part the browser
 * cannot do yet set up as nothing — the state the desktop is in before
 * anything is connected. No Tauri reaches here, and none of the application's
 * test fakes (ESLint holds both); each web adapter replaces one port (#663–#667).
 */
export function composeWeb(): AppPorts {
  return {
    appInfo: staticAppInfo({ name: 'DFAI', version: webPackage.version, build: null }),
    ...sampleVault(),
    sources: NO_SOURCES,
    links: { open: notYet },
    snapshot: { capture: notYet },
    api: { ...NO_LOCAL_API, clipboard: browserClipboard, mcpEntry: null },
    chat: NO_CLAUDE,
    activity: { store: sessionActivityStore(), closing: { beforeClose: async () => () => {} } },
    sync: {
      git: () => NO_GIT,
      folders: NO_GIT_FOLDERS,
      files: sessionSyncFilesPerVault(),
      github: NO_GITHUB,
      pause: browserSyncPause,
      thisMac: { name: async () => 'This browser', id: browserMacId(() => crypto.randomUUID()) },
      sleepClock: { asleepMs: async () => 0 },
    },
    googleCalendar: NO_GOOGLE_CALENDAR,
    granola: { port: NO_GRANOLA, records: browserGranolaPullRecords },
    slack: NO_SLACK,
    globalCapture: { port: NO_GLOBAL_CAPTURE, store: browserGlobalCaptureStore },
  };
}

/** The sync's files for each vault, kept apart as the desktop keeps them in each vault. */
function sessionSyncFilesPerVault(): AppPorts['sync']['files'] {
  const byVault = new Map<string, ReturnType<typeof sessionSyncFiles>>();
  return (vault) => {
    const files = byVault.get(vault) ?? sessionSyncFiles();
    byVault.set(vault, files);
    return files;
  };
}
