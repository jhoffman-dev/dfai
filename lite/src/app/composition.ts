import {
  createSyncNow,
  createSyncScheduler,
  openVault,
  VaultSession,
  type Clock,
  type NoteStore,
  type RepoSettings,
  type Settings,
  type SettingsStore,
} from '../application/index.ts';
import { systemClock, systemTimers } from '../adapters/clock/index.ts';
import { createGitHubRemote, gitBlobShaOfText } from '../adapters/github/index.ts';
import { openIdbNoteStore } from '../adapters/idb/index.ts';
import { sampleNoteStore } from '../adapters/memory/index.ts';
import { createMiniSearchEngine } from '../adapters/search/index.ts';
import { createLocalSettingsStore } from '../adapters/settings/index.ts';
import { buildAiIndex } from '../domain/ai-index/index.ts';
import type { AppServices } from '../ui/services.ts';
import { feedSearch } from './search-feed.ts';
import { connectSync } from './sync-controls.ts';

/** Push this long after typing stops; pull this often while the app is open. */
const PUSH_DELAY_MS = 5_000;
const PULL_EVERY_MS = 60_000;

/** A repository with a token: what sync needs to run. */
export interface Connection {
  readonly repo: RepoSettings;
  readonly token: string;
}

/** The device-side adapters: where notes and settings are kept, the time, and the repository. */
export interface DeviceAdapters {
  readonly noteStore: NoteStore;
  readonly settings: SettingsStore;
  readonly clock: Clock;
  /** Null on the sample vault: no repository and token set. */
  readonly connection: Connection | null;
}

export function connectionOf({ repo, token }: Settings): Connection | null {
  return repo === null || token === null ? null : { repo, token };
}

/** `owner/name@branch`: which remote a device's files were synced with. */
export function remoteIdentityOf({ owner, name, branch }: RepoSettings): string {
  return `${owner}/${name}@${branch}`;
}

/**
 * The adapters on this device. Settings always live in this browser. With a
 * repository connected, notes live in an IndexedDB database of that remote's
 * own (switching repository or branch opens another); without one, the app
 * runs on the fictional sample vault in memory.
 */
export async function deviceAdapters(): Promise<DeviceAdapters> {
  const settings = createLocalSettingsStore(window.localStorage);
  const connection = connectionOf(settings.load());
  const noteStore =
    connection === null
      ? sampleNoteStore()
      : await openIdbNoteStore(`dfai-lite:${remoteIdentityOf(connection.repo)}`);
  return { noteStore, settings, clock: systemClock, connection };
}

/** The page's `online` and `visibilitychange`, for the scheduler's wake-ups. */
const browserPage = {
  addEventListener(type: string, listener: () => void) {
    (type === 'visibilitychange' ? document : window).addEventListener(type, listener);
  },
  isVisible: () => document.visibilityState === 'visible',
};

function startSync(session: VaultSession, adapters: DeviceAdapters, connection: Connection) {
  const { repo, token } = connection;
  const remote = createGitHubRemote({
    owner: repo.owner,
    repo: repo.name,
    branch: repo.branch,
    token,
    fetch: window.fetch.bind(window),
  });
  const syncNow = createSyncNow({
    store: adapters.noteStore,
    remote,
    session,
    clock: adapters.clock,
    remoteIdentity: remoteIdentityOf(repo),
    hashBlob: gitBlobShaOfText,
    derivedFiles: buildAiIndex,
  });
  const scheduler = createSyncScheduler({
    syncNow,
    timers: systemTimers,
    clock: adapters.clock,
    pushDelayMs: PUSH_DELAY_MS,
    pullEveryMs: PULL_EVERY_MS,
  });
  return connectSync({ scheduler, session, page: browserPage });
}

/**
 * Builds the services and opens the vault (no network), with search fed from
 * the session. `start` begins syncing: call it once the app is on screen.
 */
export async function composeApp(
  adapters: DeviceAdapters,
): Promise<{ services: AppServices; start: () => void }> {
  const session = new VaultSession();
  const search = createMiniSearchEngine();
  feedSearch(session, search);
  await openVault({ store: adapters.noteStore, session });
  const sync =
    adapters.connection === null ? null : startSync(session, adapters, adapters.connection);
  const services: AppServices = {
    noteStore: adapters.noteStore,
    settings: adapters.settings,
    clock: adapters.clock,
    session,
    search,
    sync,
    // A new repository, branch or token is another remote, and another database: start afresh.
    reconnect: () => window.location.reload(),
  };
  return { services, start: () => sync?.start() };
}
