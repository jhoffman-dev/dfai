import { FAKE_VAULT, FakeGitHub } from '@dfai/adapters/testing/github';
import {
  gitHubVaultKey,
  indexedDbReadCache,
  indexedDbSaveQueue,
  rememberedGitHubVault,
} from '@dfai/adapters';
import type { WebIndex } from '@dfai/adapters/web-index';
import {
  NOTE_NEEDS_CONNECTION,
  signOutAndForget,
  type AuthPort,
  type AuthState,
  switchableConnection,
} from '@dfai/application';
import { createVaultPath as p } from '@dfai/domain';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import {
  askToLoseSaves,
  forgettingDevice,
  gitHubWebVault,
  unsentSaves,
  type WebDevice,
} from './github-vault.ts';

/**
 * #667 end to end below the screen: the web build's vault over a stand-in
 * GitHub (no network), its cache in a stand-in IndexedDB, and a connection
 * the test turns off.
 */

function memoryStorage() {
  const held = new Map<string, string>();
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
  };
}

function signedIn() {
  const github = new FakeGitHub({ files: { 'Garden plan.md': '# Garden plan\n' } });
  const connection = switchableConnection(true);
  const forgotten: string[] = [];
  const disk = new IDBFactory();
  const device: WebDevice = {
    cache: indexedDbReadCache(disk),
    saveQueue: indexedDbSaveQueue(disk),
    index: { forget: async (vault: string) => void forgotten.push(vault) } as WebIndex,
    connection,
    remembered: rememberedGitHubVault(memoryStorage()),
    page: { fetch: github.fetch, reportError: vi.fn() } as unknown as Window,
  };
  let state: AuthState = { status: 'signed-in' };
  const listeners = new Set<() => void>();
  const auth = {
    state: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tokenForRequest: async () => [...github.tokens][0]!,
    rejected: async () => {},
  } as unknown as AuthPort;
  const vault = gitHubWebVault({ auth, device });
  return {
    github,
    connection,
    device,
    vault,
    forgotten,
    offline: () => (state = { status: 'signed-out', reason: 'network' }),
    /** Signed in again, as the session is once back online. */
    online: () => {
      state = { status: 'signed-in' };
      listeners.forEach((listener) => listener());
    },
    /** The page loaded again: a new session over the same device, its queue read back from disk. */
    reloaded: () => gitHubWebVault({ auth, device }),
  };
}

describe('the web build’s GitHub vault', () => {
  it('opens the vault found at sign-in, and a note read before with no network', async () => {
    const { vault, connection } = signedIn();
    const { fs, store } = vault.ports.vault;
    expect((await store.read())?.absolutePath).toBe(gitHubVaultKey(FAKE_VAULT));
    expect((await fs.readTextFile(p('Garden plan.md'))).text).toBe('# Garden plan\n');
    await vi.waitFor(async () => {
      connection.set(false);
      expect((await fs.readTextFile(p('Garden plan.md'))).text).toBe('# Garden plan\n');
    });
  });

  it('answers from the device when the app opened with the session kept away by the network', async () => {
    const { vault, offline, device } = signedIn();
    const { fs, store } = vault.ports.vault;
    await store.read();
    await fs.readTextFile(p('Garden plan.md'));
    await vi.waitFor(async () => expect(await device.cache.facts()).not.toEqual([]));
    offline();
    // The browser says online, but there is no token to be had: the read is unreachable, so kept.
    expect((await fs.readTextFile(p('Garden plan.md'))).text).toBe('# Garden plan\n');
  });

  it('says a note never opened needs a connection', async () => {
    const { vault, connection } = signedIn();
    const { fs, store } = vault.ports.vault;
    await store.read();
    connection.set(false);
    await expect(fs.readTextFile(p('Garden plan.md'))).rejects.toThrow(NOTE_NEEDS_CONNECTION);
  });

  it('keeps a save made offline on disk through a reload, and commits it once signed in again', async () => {
    const { vault, connection, github, reloaded, offline, online } = signedIn();
    const { fs, store } = vault.ports.vault;
    const where = (await store.read())!.absolutePath;
    const read = await fs.readTextFile(p('Garden plan.md'));
    connection.set(false);
    const saving = { vault: where, path: p('Garden plan.md'), expectedModified: read.modified };
    await fs.writeTextFile({ ...saving, contents: '# Garden plan\n\nOffline.\n' });
    expect(vault.ports.notes.pendingSaves?.stateOf(where, 'Garden plan.md')).toEqual({
      kind: 'waiting',
    });
    vault.stop();
    offline();
    const after = reloaded();
    connection.set(true);
    // Online, but the session is not back yet: nothing is sent, nothing is lost.
    await vi.waitFor(() =>
      expect(after.ports.notes.pendingSaves?.stateOf(where, 'Garden plan.md')).toEqual({
        kind: 'waiting',
      }),
    );
    expect(await github.textAt('Garden plan.md')).toBe('# Garden plan\n');
    online();
    await vi.waitFor(async () =>
      expect(await github.textAt('Garden plan.md')).toBe('# Garden plan\n\nOffline.\n'),
    );
    await vi.waitFor(() =>
      expect(after.ports.notes.pendingSaves?.stateOf(where, 'Garden plan.md')).toBeNull(),
    );
  });

  it('refuses a queued save once a Mac moved the note, never writing over it', async () => {
    const { vault, connection, github, device } = signedIn();
    const { fs, store } = vault.ports.vault;
    const where = (await store.read())!.absolutePath;
    const read = await fs.readTextFile(p('Garden plan.md'));
    connection.set(false);
    await fs.writeTextFile({
      vault: where,
      path: p('Garden plan.md'),
      contents: 'mine',
      expectedModified: read.modified,
    });
    await github.commitOutside({ 'Garden plan.md': 'the Mac’s' });
    connection.set(true);
    await vi.waitFor(() =>
      expect(vault.ports.notes.pendingSaves?.stateOf(where, 'Garden plan.md')?.kind).toBe(
        'refused',
      ),
    );
    expect(await github.textAt('Garden plan.md')).toBe('the Mac’s');
    expect((await device.saveQueue.all()).map((save) => save.contents)).toEqual(['mine']);
    expect(await unsentSaves(device)).toBe(1);
  });

  it('asks before a sign-out loses saves, and loses none on a no', async () => {
    const { device } = signedIn();
    await device.saveQueue.put({
      key: 'k',
      vault: 'v',
      path: 'Garden plan.md',
      contents: 'waiting',
      expectedModified: 1,
      order: 0,
      provisional: -1,
      refused: null,
    });
    const asked: string[] = [];
    const confirm = (text: string) => (asked.push(text), false);
    const outcome = await signOutAndForget({
      unsent: () => unsentSaves(device),
      confirmLosing: askToLoseSaves({ confirm }),
      signOut: async () => {},
      forget: forgettingDevice(device),
    });
    expect(outcome).toBe('kept');
    expect(asked).toEqual([expect.stringContaining('A save has not reached GitHub yet')]);
    expect(await unsentSaves(device)).toBe(1);
  });

  it('forgets the cache, the index file and the vault at sign-out', async () => {
    const { vault, device, connection, forgotten } = signedIn();
    const { fs, store } = vault.ports.vault;
    await store.read();
    await fs.readTextFile(p('Garden plan.md'));
    await vi.waitFor(async () => expect(await device.cache.facts()).not.toEqual([]));
    vault.stop();
    await signOutAndForget({ signOut: async () => {}, forget: forgettingDevice(device) });
    expect(await device.cache.facts()).toEqual([]);
    expect(forgotten).toEqual([gitHubVaultKey(FAKE_VAULT)]);
    expect(device.remembered.read()).toBeNull();
    expect(await unsentSaves(device)).toBe(0);
    connection.set(false);
    await expect(fs.readTextFile(p('Garden plan.md'))).rejects.toThrow();
  });
});
