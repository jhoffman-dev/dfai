import {
  browserConnection,
  gitHubApi,
  gitHubVaultKey,
  gitHubVaultPorts,
  indexedDbReadCache,
  indexedDbSaveQueue,
  rememberedGitHubVault,
  remarkMarkdown,
  webWorkerNoteDeriver,
  type GitHubToken,
} from '@dfai/adapters';
import { webIndex, type WebIndex } from '@dfai/adapters/web-index';
import {
  cachedVaultFs,
  keptReads,
  offlineSaves,
  revalidateKeptNotes,
  VaultUnreachableError,
  waitsForNetwork,
  type AuthPort,
  type ConnectionPort,
  type ReadCacheStore,
  type SaveQueueStore,
} from '@dfai/application';
import { READ_CACHE_CAP_BYTES, WEB_DEVICE } from '@dfai/domain';
import type { IndexPorts, NotePorts, OnHost, VaultPorts } from '@dfai/shell';

/** The vault's ports, as the shell reads the vault through them. */
export interface WebVaultPorts {
  readonly vault: OnHost<VaultPorts>;
  readonly notes: OnHost<NotePorts>;
  readonly index: OnHost<IndexPorts>;
}

/**
 * What this browser keeps for the page's whole life (#667), across one
 * sign-in and the next: the read cache's database, the index's worker (one
 * worker holds the index's files, so there is never a second), whether the
 * device is online, and the vault found at sign-in.
 */
export interface WebDevice {
  readonly cache: ReadCacheStore;
  /** Saves made offline, waiting to be sent: on disk, so they outlive a reload. */
  readonly saveQueue: SaveQueueStore;
  readonly index: WebIndex;
  readonly connection: ConnectionPort;
  readonly remembered: ReturnType<typeof rememberedGitHubVault>;
  readonly page: Window;
}

export function webDevice(page: Window): WebDevice {
  const remembered = rememberedGitHubVault(page.localStorage);
  return {
    cache: indexedDbReadCache(page.indexedDB),
    saveQueue: indexedDbSaveQueue(page.indexedDB),
    index: webIndex({ openVault: () => openVaultOf(remembered) }),
    connection: browserConnection(page),
    remembered,
    page,
  };
}

const openVaultOf = (remembered: WebDevice['remembered']) => {
  const where = remembered.read();
  return where === null ? null : gitHubVaultKey(where);
};

/**
 * The signed-in vault (#667): the GitHub repository (#664) through the read
 * cache, and the browser's index (#666). The answer's `stop` ends the
 * session's keeping, before what it kept is forgotten at sign-out.
 */
export function gitHubWebVault({ auth, device }: { auth: AuthPort; device: WebDevice }) {
  const { page, connection } = device;
  const token = offlineAwareToken(auth);
  // The wall clock at the edge: what was used when, and when GitHub's rate limit lifts.
  const clock = { now: () => Date.now() };
  const report = (error: unknown) => page.reportError(error);
  const api = gitHubApi({ fetch: (input, init) => page.fetch(input, init), token, clock });
  const github = gitHubVaultPorts({ api, remembered: device.remembered });
  const kept = keptReads({ store: device.cache, clock, capBytes: READ_CACHE_CAP_BYTES, report });
  const saves = offlineSaves({
    fs: cachedVaultFs({ fs: github.fs, kept, connection }),
    store: device.saveQueue,
    connection,
    device: WEB_DEVICE,
    report,
  });
  const { fs } = saves;
  // Back online, or signed in again after opening offline: what waits is sent, then kept notes caught up.
  const caughtUp = () => {
    if (device.remembered.read() === null) return;
    saves
      .send()
      .then(() => revalidateKeptNotes({ fs: github.fs, kept, connection }))
      .catch(report);
  };
  const stopListening = connection.onChange((online) => {
    if (online) caughtUp();
  });
  const stopAuth = auth.subscribe(() => {
    if (auth.state().status === 'signed-in') caughtUp();
  });
  caughtUp();
  const ports: WebVaultPorts = {
    vault: {
      fs,
      picker: github.picker,
      store: github.store,
      // The web has no watcher (ADR-0051, fileWatching); a change elsewhere is met at the next save.
      watch: { start: async () => {}, onChange: async () => () => {} },
    },
    notes: { fs, markdown: remarkMarkdown, device: WEB_DEVICE, pendingSaves: saves.pending },
    index: { fs, index: device.index, markdown: remarkMarkdown, deriver: webWorkerNoteDeriver },
  };
  return {
    ports,
    stop: () => {
      stopListening();
      stopAuth();
      kept.stop();
    },
  };
}

/**
 * The session's token for GitHub, but while only the network keeps the
 * session away (the app opened from the device), a request is unreachable,
 * not refused: a read is then answered from what the device kept.
 */
function offlineAwareToken(auth: AuthPort): GitHubToken {
  return {
    tokenForRequest: () =>
      waitsForNetwork(auth.state())
        ? Promise.reject(new VaultUnreachableError('signing in to GitHub needs a connection'))
        : auth.tokenForRequest(),
    rejected: (accessToken) => auth.rejected(accessToken),
  };
}

/**
 * How many saves wait on the device, read from where they are stored: the
 * count a sign-out asks about, whatever the session in memory holds.
 */
export const unsentSaves = async (device: WebDevice): Promise<number> =>
  (await device.saveQueue.all()).length;

/** What a sign-out asks while saves wait; no keeps the person signed in, with them. */
export function askToLoseSaves(page: Pick<Window, 'confirm'>) {
  return async (count: number): Promise<boolean> =>
    page.confirm(
      `${count === 1 ? 'A save has' : `${count} saves have`} not reached GitHub yet. ` +
        `Signing out deletes ${count === 1 ? 'it' : 'them'} from this device for good. Sign out anyway?`,
    );
}

/** Everything the device kept of the vault, each forgotten in its own step at sign-out. */
export function forgettingDevice(device: WebDevice): readonly (() => Promise<void>)[] {
  return [
    () => device.cache.clear(),
    () => device.saveQueue.clear(),
    async () => {
      const vault = openVaultOf(device.remembered);
      if (vault !== null) await device.index.forget(vault);
    },
    async () => device.remembered.forget(),
  ];
}
