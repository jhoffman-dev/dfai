import { FakeGitHub } from '@dfai/adapters/testing/github';
import { indexedDbReadCache, indexedDbSaveQueue, rememberedGitHubVault } from '@dfai/adapters';
import type { WebIndex } from '@dfai/adapters/web-index';
import {
  memoryQueueLock,
  sharedQueueChanges,
  switchableConnection,
  type AuthPort,
  type AuthState,
} from '@dfai/application';
import { createVaultPath as p } from '@dfai/domain';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { gitHubWebVault, type WebDevice } from './github-vault.ts';

/*
 * Second attack on PR #753: the closed mark, saves while the login is
 * unconfirmed, and the re-check before sending. One device (one stand-in
 * IndexedDB), tabs as sessions over it, a stand-in GitHub whose /user can be
 * made unreachable.
 */

const GARDEN = 'Garden plan.md';
const SHED = 'Shed.md';

function memoryStorage() {
  const held = new Map<string, string>();
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
  };
}

function onDevice() {
  const github = new FakeGitHub({ files: { [GARDEN]: '# Garden plan\n', [SHED]: '# Shed\n' } });
  const connection = switchableConnection(true);
  const disk = new IDBFactory();
  const changes = sharedQueueChanges();
  let userReachable = true;
  const fetchThrough: typeof fetch = (input, init) => {
    const url = String(input);
    if (!userReachable && new URL(url).pathname === '/user')
      return Promise.reject(new TypeError('Failed to fetch'));
    return github.fetch(input, init);
  };
  const device: WebDevice = {
    cache: indexedDbReadCache(disk),
    saveQueue: indexedDbSaveQueue(disk),
    queueLock: memoryQueueLock(),
    queueChanges: changes(),
    index: { forget: async () => {} } as unknown as WebIndex,
    connection,
    remembered: rememberedGitHubVault(memoryStorage()),
    page: {
      fetch: fetchThrough,
      reportError: vi.fn(),
      confirm: () => false,
    } as unknown as Window,
  };
  const state: AuthState = { status: 'signed-in' };
  let token = [...github.tokens][0]!;
  const auth = {
    state: () => state,
    subscribe: () => () => {},
    // Read per request, as the shared token store is: another tab's sign-in changes it.
    tokenForRequest: async () => token,
    rejected: async () => {},
    signOut: async () => {},
  } as unknown as AuthPort;
  return {
    github,
    connection,
    device,
    setUserReachable: (reachable: boolean) => (userReachable = reachable),
    /** Another person signs in on this device, in another tab: the token store now holds theirs. */
    signInElsewhereAs: (login: string) => {
      token = `ghu_${login}`;
      github.tokens.add(token);
      github.logins.set(token, login);
      return token;
    },
    tab: (freshSignIn = false) =>
      gitHubWebVault({ auth, device: { ...device, queueChanges: changes() }, freshSignIn }),
  };
}

type Session = ReturnType<typeof gitHubWebVault>;

async function openNote(session: Session, path = GARDEN) {
  const where = (await session.ports.vault.store.read())!.absolutePath;
  const read = await session.ports.vault.fs.readTextFile(p(path));
  return { where, read };
}

const write = (
  session: Session,
  { where, path = GARDEN, contents, expectedModified }: WriteArgs,
): Promise<number> =>
  session.ports.vault.fs.writeTextFile({ vault: where, path: p(path), contents, expectedModified });

interface WriteArgs {
  where: string;
  path?: string;
  contents: string;
  expectedModified: number;
}

const failureOf = (attempt: Promise<unknown>) =>
  attempt.then(
    () => null,
    (error: Error) => error.message,
  );

describe('the web build’s save queue: second attack on #753', () => {
  it('takes saves again once GitHub confirms the login after the app opened unconfirmed over a closed mark', async () => {
    const { connection, device, tab, setUserReachable } = onDevice();
    // Set up the way a sign-out leaves it when the tab closes after `closeForSignOut` and
    // before `auth.signOut` and forgetting finish: the closed mark is stored, the remembered
    // vault and the token are still there.
    const first = tab();
    await openNote(first);
    first.stop();
    await device.saveQueue.setClosed(true);
    // The iPad opens offline: /user cannot be asked, so the vault read does not reopen.
    setUserReachable(false);
    const session = tab();
    const { where, read } = await openNote(session);
    // Back online: the session's own check confirms the login, but not through the vault
    // read that reopens, so the closed mark is never cleared.
    setUserReachable(true);
    connection.set(false);
    connection.set(true);
    let failure: string | null = null;
    await vi.waitFor(async () => {
      failure = await failureOf(
        write(session, { where, contents: 'typed once online', expectedModified: read.modified }),
      );
      // Fixed (#753): until GitHub confirms, the closed mark refuses ('signing out'); once it
      // does, on whichever check, the queue reopens and the save is taken.
      expect(failure).toBeNull();
    });
    // Observed: 'signing out: nothing more is saved on this device' for every save, online
    // and confirmed, for the whole session.
    expect(failure).toBeNull();
  });

  it('keeps an edit typed while the login is unconfirmed past the tab closing', async () => {
    const { device, tab, setUserReachable } = onDevice();
    const first = tab();
    await openNote(first);
    first.stop();
    // The iPad opens the remembered vault with GitHub's /user unreachable: the login is unconfirmed.
    setUserReachable(false);
    const unconfirmed = tab();
    const { where, read } = await openNote(unconfirmed);
    const failure = await failureOf(
      write(unconfirmed, {
        where,
        contents: 'typed before /user answered',
        expectedModified: read.modified,
      }),
    );
    // Fixed (#753): a session restored for the remembered account keeps the save on the device,
    // as that account's, sent only once GitHub confirms it.
    expect(failure).toBeNull();
    // The tab closes: on the web nothing runs the closing tasks and no pane unmounts, so the
    // stranded-work keeper is never handed the typing. Whatever survives is on the device.
    unconfirmed.stop();
    setUserReachable(true);
    const after = tab();
    const reopened = await openNote(after);
    const onDeviceNow = (await device.saveQueue.all()).map((save) => save.contents);
    // Observed: the queue is empty, and the note reads '# Garden plan\n': the typing is gone,
    // though the pane said "your edit stays here".
    expect({ text: reopened.read.text, queued: onDeviceNow }).not.toEqual({
      text: '# Garden plan\n',
      queued: [],
    });
  });

  it('sends no further waiting save once another login holds the token mid-queue', async () => {
    const { github, connection, tab, signInElsewhereAs } = onDevice();
    const session = tab();
    const garden = await openNote(session, GARDEN);
    const shed = await openNote(session, SHED);
    connection.set(false);
    await write(session, {
      where: garden.where,
      contents: 'garden, offline',
      expectedModified: garden.read.modified,
    });
    await write(session, {
      where: shed.where,
      path: SHED,
      contents: 'shed, offline',
      expectedModified: shed.read.modified,
    });
    let switched = false;
    let tobias = '';
    // As soon as the first save's commit is in, someone else signs in in another tab.
    github.intercept(
      (request) => request.method === 'PATCH' && request.path.includes('/git/refs/'),
      async (request) => {
        const answer = await github.respond(request);
        tobias = signInElsewhereAs('tobias-fenn');
        switched = true;
        return answer;
      },
    );
    connection.set(true);
    await vi.waitFor(async () => {
      expect(switched).toBe(true);
      const askedAsTobias = github.received.some(
        (request) =>
          request.path === '/user' && request.headers.get('Authorization') === `Bearer ${tobias}`,
      );
      expect(askedAsTobias || (await github.textAt(SHED)) === 'shed, offline').toBe(true);
    });
    const writtenAsTobias = github.received.filter(
      (request) =>
        request.method !== 'GET' && request.headers.get('Authorization') === `Bearer ${tobias}`,
    );
    // Observed: the Shed save is committed with Tobias's token; `confirmAgain` ran once, before the queue.
    expect(writtenAsTobias).toEqual([]);
  });

  it('never sends an unconfirmed save under the other login GitHub then confirms', async () => {
    const { github, device, tab, setUserReachable, signInElsewhereAs } = onDevice();
    const first = tab();
    await openNote(first);
    first.stop();
    setUserReachable(false);
    const restored = tab();
    const { where, read } = await openNote(restored);
    await write(restored, {
      where,
      contents: 'hers, unconfirmed',
      expectedModified: read.modified,
    });
    // The token turns out to be someone else's, and GitHub says so once it can be asked.
    const tobias = signInElsewhereAs('tobias-fenn');
    setUserReachable(true);
    await expect(restored.ports.vault.store.read()).rejects.toThrow(/mara-quill/);
    const writtenAsTobias = github.received.filter(
      (request) =>
        request.method !== 'GET' && request.headers.get('Authorization') === `Bearer ${tobias}`,
    );
    expect(writtenAsTobias).toEqual([]);
    expect((await device.saveQueue.all()).map((save) => save.contents)).toEqual([
      'hers, unconfirmed',
    ]);
  });

  it('a fresh sign-in with its login not yet known sees and adds to none of the last account’s saves', async () => {
    const { device, tab, setUserReachable, connection } = onDevice();
    const first = tab();
    const opened = await openNote(first);
    connection.set(false);
    await write(first, {
      where: opened.where,
      contents: 'hers, waiting',
      expectedModified: opened.read.modified,
    });
    first.stop();
    setUserReachable(false);
    const fresh = tab(true);
    const { where } = await openNote(fresh);
    expect(fresh.ports.notes.pendingSaves?.stateOf(where, GARDEN)).toBeNull();
    await expect(write(fresh, { where, contents: 'his', expectedModified: -1 })).rejects.toThrow(
      'GitHub says who is signed in',
    );
    expect((await device.saveQueue.all()).map((save) => save.contents)).toEqual(['hers, waiting']);
  });
});
