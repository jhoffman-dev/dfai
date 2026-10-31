import webPackage from '../package.json' with { type: 'json' };
import { staticAppInfo } from '@dfai/adapters';
import {
  failed,
  fakeGoogleCalendar,
  fakeGranola,
  fakeSleepClock,
  fakeSlack,
  memoryActivityStore,
  memorySyncFiles,
  scriptedFolders,
  scriptedGit,
  type GlobalCapturePort,
  type ModelProvider,
} from '@dfai/application';
import {
  browserClipboard,
  browserGlobalCaptureStore,
  type AppPorts,
  type ChatPorts,
  type LocalApiPorts,
  type SourcePorts,
  type SyncHostPorts,
} from '@dfai/shell';
import { sampleVault } from './sample-vault.ts';

/**
 * The web's composition root, as a stub (#656): the shared shell on the
 * sample vault, with every part the browser cannot do yet connected to
 * nothing — the state the desktop is in before anything is set up. No Tauri
 * reaches here (ESLint holds it); each web adapter replaces one port (#663–#667).
 */
export function composeWeb(): AppPorts {
  return {
    appInfo: staticAppInfo({ name: 'DFAI', version: webPackage.version, build: null }),
    ...sampleVault(),
    sources: NO_SOURCES,
    links: { open: notYet },
    snapshot: { capture: notYet },
    api: NO_LOCAL_API,
    chat: NO_CLAUDE,
    activity: { store: memoryActivityStore(), closing: { beforeClose: async () => () => {} } },
    sync: NO_SYNC,
    googleCalendar: fakeGoogleCalendar().port,
    granola: {
      port: { ...fakeGranola().port, status: async () => ({ hasKey: false, lastRefusal: null }) },
      records: { read: () => ({ watermark: null, lastPullAt: null }), write: () => {} },
    },
    slack: fakeSlack(() => ({ ok: false }), { hasToken: false }),
    globalCapture: { port: NO_GLOBAL_CAPTURE, store: browserGlobalCaptureStore },
  };
}

const NOT_YET = 'Not in the web build yet.';
const notYet = () => Promise.reject(new Error(NOT_YET));

const NO_SOURCES: SourcePorts = {
  http: { get: notYet },
  sqlite: { query: notYet, pick: async () => null },
  secrets: { list: async () => [], set: notYet, bind: notYet, remove: notYet },
};

/** The local API is a server on the desktop's own machine; a browser has none to run. */
const NO_LOCAL_API: LocalApiPorts = {
  bridge: { serve: async () => () => {} },
  settings: {
    status: async () => ({ enabled: false, port: null, running: false, file: '' }),
    setEnabled: notYet,
    token: notYet,
    rotateToken: notYet,
  },
  clipboard: browserClipboard,
  mcpEntry: null,
};

const unreachable: ModelProvider = {
  id: 'claude-code',
  status: async () => ({ ready: false, problem: 'unavailable', message: NOT_YET, fix: null }),
  stream: () => {
    throw new Error(NOT_YET);
  },
};
const NO_CLAUDE: ChatPorts = { claudeCode: unreachable, anthropicApi: () => unreachable };

/** A vault in no repository: sync is simply not set up, as on a desktop that never set it up. */
const NO_SYNC: SyncHostPorts = {
  git: () => scriptedGit({ script: { topLevel: failed('fatal: not a git repository', 128) } }).git,
  folders: scriptedFolders(),
  files: () => memorySyncFiles().port,
  github: { listRepositories: async () => ({ code: 0, stdout: '[]', stderr: '' }) },
  pause: { read: () => false, write: () => {} },
  thisMac: { name: async () => 'This browser', id: async () => 'web-stub' },
  sleepClock: fakeSleepClock().port,
};

const NO_GLOBAL_CAPTURE: GlobalCapturePort = {
  status: async () => ({ shortcut: null, registered: false, problem: null }),
  set: async (shortcut) => ({ shortcut, registered: false, problem: null }),
  listen: async () => () => {},
};
