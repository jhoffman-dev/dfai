import {
  browserConnection,
  gitHubApi,
  gitHubVaultKey,
  gitHubVaultPorts,
  indexedDbReadCache,
  indexedDbSaveQueue,
  broadcastQueueChanges,
  rememberedGitHubVault,
  remarkMarkdown,
  webWorkerNoteDeriver,
  type GitHubToken,
} from '@dfai/adapters';
import { webIndex, type WebIndex } from '@dfai/adapters/web-index';
import {
  AccountSwitchRefusedError,
  adoptAccount,
  signOutAndForget,
  cachedVaultFs,
  keptReads,
  offlineSaves,
  revalidateKeptNotes,
  VaultUnreachableError,
  waitsForNetwork,
  type AuthPort,
  type ConnectionPort,
  type ReadCacheStore,
  type SaveQueueChanges,
  type SaveQueueLock,
  type SaveQueueStore,
} from '@dfai/application';
import { isUnsent, READ_CACHE_CAP_BYTES, WEB_DEVICE } from '@dfai/domain';
import type { IndexPorts, NotePorts, OnHost, VaultPorts } from '@dfai/shell';
import { crossTabLock } from './web-auth.ts';
import { webClosing } from './web-closing.ts';

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
  /** Held for each turn of the save queue, so the origin's tabs take turns. */
  readonly queueLock: SaveQueueLock;
  /** Each tab telling the others the queue changed. */
  readonly queueChanges: SaveQueueChanges;
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
    queueLock: (task) => crossTabLock(page)('dfai-save-queue', task),
    queueChanges: broadcastQueueChanges(
      typeof BroadcastChannel === 'function' ? (name) => new BroadcastChannel(name) : undefined,
    ),
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

/** Whose kept reads are answered: the remembered account and its vault, or no one's. */
const accountOf = (remembered: WebDevice['remembered']) => {
  const where = remembered.read();
  return where === null ? null : `${where.login}\u0001${gitHubVaultKey(where)}`;
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
  const github = gitHubVaultPorts({
    api,
    remembered: device.remembered,
    // Another login than the one the device's data is for: that data goes before anything opens,
    // and its saves only once the person agrees; never sent under the new login.
    beforeOpen: async (previous, login) => {
      await adoptAccount({
        previous: previous.login,
        signedInAs: login,
        forgetPrevious: () => forgetEverything(device),
        unsent: () => saves.unsent((account) => account !== login),
        confirmLosing: askToLoseSaves(page),
      });
    },
  });
  const kept = keptReads({
    store: device.cache,
    clock,
    capBytes: READ_CACHE_CAP_BYTES,
    report,
    scope: () => accountOf(device.remembered),
  });
  const saves = offlineSaves({
    fs: cachedVaultFs({ fs: github.fs, kept, connection }),
    store: device.saveQueue,
    connection,
    device: WEB_DEVICE,
    report,
    lock: device.queueLock,
    changes: device.queueChanges,
    account: () => device.remembered.read()?.login ?? null,
  });
  const { fs } = saves;
  let refused = false;
  let checking: Promise<void> | null = null;
  /**
   * Who GitHub says is signed in: checked again while unknown (the vault opened offline), one
   * check at a time, and never again in this session once the person kept the last account's saves.
   */
  const signedIn = async () => {
    await github.opened;
    if (github.signedIn() === null && !refused) {
      checking ??= github.store
        .read()
        .then(() => undefined)
        .catch((error: unknown) => {
          if (error instanceof AccountSwitchRefusedError) refused = true;
          else if (!(error instanceof VaultUnreachableError)) report(error);
        })
        .finally(() => (checking = null));
      await checking;
    }
    return github.signedIn();
  };
  // Back online, or signed in again after opening offline: what waits is sent, then kept notes
  // caught up; only as the login GitHub confirmed, never on the previous account's vault.
  const caughtUp = () => {
    signedIn()
      .then(async (login) => {
        if (login === null) return;
        await saves.send(login);
        await revalidateKeptNotes({ fs: github.fs, kept, connection });
      })
      .catch(report);
  };
  const stopListening = connection.onChange((online) => {
    if (online) caughtUp();
  });
  const stopAuth = auth.subscribe(() => {
    if (auth.state().status === 'signed-in') caughtUp();
  });
  caughtUp();
  const closing = webClosing();
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
    /** What the shell's panes write before the window closes; a sign-out runs it first. */
    closing,
    saves,
    stop: () => {
      stopListening();
      stopAuth();
      saves.stop();
      kept.stop();
    },
  };
}

export type WebSession = ReturnType<typeof gitHubWebVault>;

/**
 * Signing out of the web build (#667): the panes write what still waits in
 * their autosave into the queue first, so every unsent save is counted; on
 * a no, nothing changes. Then the queue takes no more saves, the session
 * stops, and the device forgets everything it kept.
 */
export function signOutOfDevice({
  auth,
  device,
  session,
}: {
  auth: Pick<AuthPort, 'signOut'>;
  device: WebDevice;
  session: WebSession;
}): Promise<'signed-out' | 'kept'> {
  return session.closing.close().then(() =>
    signOutAndForget({
      unsent: () => unsentSaves(device),
      confirmLosing: askToLoseSaves(device.page),
      signOut: async () => {
        await session.saves.clear();
        session.stop();
        await auth.signOut();
      },
      forget: forgettingDevice(device),
    }),
  );
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
  (await device.saveQueue.all()).filter(isUnsent).length;

/** What a sign-out asks while saves wait; no keeps the person signed in, with them. */
export function askToLoseSaves(page: Pick<Window, 'confirm'>) {
  return async (count: number): Promise<boolean> =>
    page.confirm(
      `${count === 1 ? 'A save has' : `${count} saves have`} not reached GitHub yet. ` +
        `Signing out deletes ${count === 1 ? 'it' : 'them'} from this device for good. Sign out anyway?`,
    );
}

/** Forgets everything the device kept, and fails if any of it is left. */
async function forgetEverything(device: WebDevice): Promise<void> {
  const settled = await Promise.allSettled(forgettingDevice(device).map((step) => step()));
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
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
