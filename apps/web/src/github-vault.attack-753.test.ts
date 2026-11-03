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
import { gitHubWebVault, signOutOfDevice, unsentSaves, type WebDevice } from './github-vault.ts';

/*
 * Attack on PR #753: the web build's save queue over a stand-in GitHub and a
 * stand-in IndexedDB, with two tabs (two sessions) on one device.
 */

function memoryStorage() {
  const held = new Map<string, string>();
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
  };
}

function onDevice() {
  const github = new FakeGitHub({ files: { 'Garden plan.md': '# Garden plan\n' } });
  const connection = switchableConnection(true);
  const asked: string[] = [];
  const disk = new IDBFactory();
  const queue = indexedDbSaveQueue(disk);
  let putsFail = false;
  const changes = sharedQueueChanges();
  const device: WebDevice = {
    cache: indexedDbReadCache(disk),
    saveQueue: {
      ...queue,
      put: async (save) => {
        if (putsFail) throw new DOMException('the disk is full', 'QuotaExceededError');
        return queue.put(save);
      },
    },
    queueLock: memoryQueueLock(),
    queueChanges: changes(),
    index: { forget: async () => {} } as unknown as WebIndex,
    connection,
    remembered: rememberedGitHubVault(memoryStorage()),
    page: {
      fetch: github.fetch,
      reportError: vi.fn(),
      confirm: (text: string) => (asked.push(text), false),
    } as unknown as Window,
  };
  const state: AuthState = { status: 'signed-in' };
  const authAs = (token: string) =>
    ({
      state: () => state,
      subscribe: () => () => {},
      tokenForRequest: async () => token,
      rejected: async () => {},
      signOut: async () => {},
    }) as unknown as AuthPort;
  const firstToken = [...github.tokens][0]!;
  return {
    github,
    connection,
    device,
    asked,
    failPuts: () => (putsFail = true),
    /** A tab: a session of its own over the device, its own channel to the other tabs. */
    tab: (token = firstToken) =>
      gitHubWebVault({ auth: authAs(token), device: { ...device, queueChanges: changes() } }),
    /** Another person signs in on this device. */
    tokenOf: (login: string) => {
      const token = `ghu_${login}`;
      github.tokens.add(token);
      github.logins.set(token, login);
      return token;
    },
  };
}

type Session = ReturnType<typeof gitHubWebVault>;

async function openNote(session: Session) {
  const where = (await session.ports.vault.store.read())!.absolutePath;
  const read = await session.ports.vault.fs.readTextFile(p('Garden plan.md'));
  return { where, read };
}

const write = (session: Session, where: string, contents: string, expectedModified: number) =>
  session.ports.vault.fs.writeTextFile({
    vault: where,
    path: p('Garden plan.md'),
    contents,
    expectedModified,
  });

describe('the web build’s save queue: attack on #753', () => {
  it.fails(
    'sends no account’s waiting save under another login GitHub has not confirmed',
    async () => {
      const { github, connection, tab, tokenOf } = onDevice();
      const hers = tab();
      const { where, read } = await openNote(hers);
      connection.set(false);
      await write(hers, where, 'hers, offline', read.modified);
      hers.stop();
      connection.set(true);
      // Tobias signs in on her iPad; GitHub cannot be asked who he is as the app opens.
      const tobias = tokenOf('tobias-fenn');
      for (let i = 0; i < 5; i += 1)
        github.intercept(
          (request) => request.path === '/user',
          () => Promise.reject(new TypeError('Failed to fetch')),
        );
      const his = tab(tobias);
      const opened = await openNote(his);
      await write(his, where, 'his typing', opened.read.modified).catch(() => undefined);
      const writtenAsTobias = github.received.filter(
        (request) =>
          request.method !== 'GET' && request.headers.get('Authorization') === `Bearer ${tobias}`,
      );
      // Observed: her queued save ('hers, offline'), then his typing, are committed to her vault
      // with his token (blob, tree, commit, ref, twice), before /user ever answered.
      expect(writtenAsTobias).toEqual([]);
    },
  );

  it.fails(
    'never signs out without asking when a closing write failed to reach the queue',
    async () => {
      const { connection, device, asked, tab, failPuts } = onDevice();
      const session = tab();
      const { where, read } = await openNote(session);
      connection.set(false);
      failPuts();
      // The pane's typing, still in its autosave wait, is written as the sign-out begins; it fails.
      await session.closing.beforeClose(() => write(session, where, 'typed', read.modified).then());
      const outcome = await signOutOfDevice({
        auth: { signOut: async () => {} },
        device,
        session,
      });
      // Observed: 'signed-out', nobody asked, and the typing is gone.
      expect({ outcome, asked: asked.length }).not.toEqual({ outcome: 'signed-out', asked: 0 });
    },
  );

  it.fails('never deletes, unasked, a save another tab was told is stored', async () => {
    const { connection, device, asked, tab } = onDevice();
    const leaving = tab();
    const typing = tab();
    await openNote(leaving);
    const { where, read } = await openNote(typing);
    connection.set(false);
    let acknowledged = false;
    // Nothing waits when the sign-out counts; the other tab's save is stored while it signs out.
    const outcome = await signOutOfDevice({
      auth: {
        signOut: async () => {
          await write(typing, where, 'typed in the other tab', read.modified).then(
            () => (acknowledged = true),
            () => undefined,
          );
        },
      },
      device,
      session: leaving,
    });
    expect(outcome).toBe('signed-out');
    expect(acknowledged).toBe(true);
    // Observed: stored, then deleted by the sign-out's forget step; nobody was asked.
    expect({ unsent: await unsentSaves(device), asked: asked.length }).not.toEqual({
      unsent: 0,
      asked: 0,
    });
  });
});
