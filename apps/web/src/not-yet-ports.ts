import type {
  GitFoldersPort,
  GitHubPort,
  GitPort,
  GitResult,
  GlobalCapturePort,
  GoogleCalendarPort,
  GranolaPort,
  ModelProvider,
  SlackPort,
} from '@dfai/application';
import type { ChatPorts, LocalApiPorts, SourcePorts } from '@dfai/shell';

/**
 * The parts of DFAI the web stub cannot do yet (#656): each reports itself
 * not set up, as on a desktop that never set it up, and refuses out loud
 * anything that would set it up or reach outside the page. Each is replaced
 * by a web adapter, or hidden by capability (#657), in its own ticket.
 */

export const NOT_YET = 'Not in the web build yet.';
export const notYet = (): Promise<never> => Promise.reject(new Error(NOT_YET));

export const NO_GOOGLE_CALENDAR: GoogleCalendarPort = {
  status: async () => ({ connected: false, clientId: null, scopes: [] }),
  connect: notYet,
  cancelConnect: async () => {},
  disconnect: async () => ({ revoked: false, shared: false }),
  listCalendars: notYet,
  createCalendar: notYet,
};

export const NO_GRANOLA: GranolaPort = {
  status: async () => ({ hasKey: false, lastRefusal: null }),
  setKey: notYet,
  forgetKey: async () => ({ hasKey: false, lastRefusal: null }),
  listNotes: notYet,
  getNote: notYet,
  getTranscriptPage: notYet,
};

export const NO_SLACK: SlackPort = {
  status: async () => ({ hasToken: false }),
  connect: notYet,
  disconnect: async () => ({ hasToken: false }),
  call: notYet,
};

/** Every git command answers as git does outside a repository: the vault is not synced. */
const notARepository = async (): Promise<GitResult> => ({
  code: 128,
  stdout: '',
  stderr: `fatal: not a git repository. ${NOT_YET}`,
});

/** Each of GitPort's commands, so the compiler holds the list to the port. */
const GIT_COMMANDS = {
  topLevel: 0,
  init: 0,
  status: 0,
  addAll: 0,
  commit: 0,
  fetch: 0,
  merge: 0,
  push: 0,
  remoteUrl: 0,
  setRemote: 0,
  currentBranch: 0,
  head: 0,
  mergeInProgress: 0,
  remoteSubject: 0,
  remoteBranchExists: 0,
  checkout: 0,
  config: 0,
  createGitHubRepository: 0,
  untrackedExact: 0,
  indexEntries: 0,
  move: 0,
  tree: 0,
  mergeBase: 0,
  hashFile: 0,
  readBlob: 0,
  remoteSettingsExist: 0,
  remoteSettings: 0,
  stageBlob: 0,
  writeFromIndex: 0,
  untrack: 0,
  unstage: 0,
  resetSoftTo: 0,
  largeUnpushed: 0,
  remoteHead: 0,
  renameBranch: 0,
} satisfies Record<keyof GitPort, 0>;

export const NO_GIT = Object.fromEntries(
  Object.keys(GIT_COMMANDS).map((command) => [command, notARepository]),
) as unknown as GitPort;

export const NO_GIT_FOLDERS: GitFoldersPort = {
  pickCloneFolder: async () => null,
  topLevelOf: notARepository,
  clone: notARepository,
  branchesAt: notARepository,
  onDisk: notYet,
};

export const NO_GITHUB: GitHubPort = { listRepositories: notARepository };

export const NO_SOURCES: SourcePorts = {
  http: { get: notYet },
  sqlite: { query: notYet, pick: async () => null },
  secrets: { list: async () => [], set: notYet, bind: notYet, remove: notYet },
};

/** The local API is a server on the desktop's own machine; a browser has none to run. */
export const NO_LOCAL_API = {
  bridge: { serve: async () => () => {} },
  settings: {
    status: async () => ({ enabled: false, port: null, running: false, file: '' }),
    setEnabled: notYet,
    token: notYet,
    rotateToken: notYet,
  },
} satisfies Omit<LocalApiPorts, 'clipboard' | 'mcpEntry'>;

const unreachable: ModelProvider = {
  id: 'claude-code',
  status: async () => ({ ready: false, problem: 'unavailable', message: NOT_YET, fix: null }),
  stream: () => {
    throw new Error(NOT_YET);
  },
};
export const NO_CLAUDE: ChatPorts = { claudeCode: unreachable, anthropicApi: () => unreachable };

/** A shortcut from any app is the system's to register; a page cannot. */
export const NO_GLOBAL_CAPTURE: GlobalCapturePort = {
  status: async () => ({ shortcut: null, registered: false, problem: null }),
  set: async (shortcut) => ({ shortcut, registered: false, problem: NOT_YET }),
  listen: async () => () => {},
};
