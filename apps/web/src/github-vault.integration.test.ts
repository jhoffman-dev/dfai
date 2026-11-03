import { FAKE_VAULT, FakeGitHub } from '@dfai/adapters/testing/github';
import { gitHubVaultKey, indexedDbReadCache, rememberedGitHubVault } from '@dfai/adapters';
import type { WebIndex } from '@dfai/adapters/web-index';
import {
  NOTE_NEEDS_CONNECTION,
  signOutAndForget,
  type AuthPort,
  type AuthState,
  switchableConnection,
  WRITE_NEEDS_CONNECTION,
} from '@dfai/application';
import { createVaultPath as p } from '@dfai/domain';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { forgettingDevice, gitHubWebVault, type WebDevice } from './github-vault.ts';

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
  const device: WebDevice = {
    cache: indexedDbReadCache(new IDBFactory()),
    index: { forget: async (vault: string) => void forgotten.push(vault) } as WebIndex,
    connection,
    remembered: rememberedGitHubVault(memoryStorage()),
    page: { fetch: github.fetch, reportError: vi.fn() } as unknown as Window,
  };
  let state: AuthState = { status: 'signed-in' };
  const auth = {
    state: () => state,
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

  it('says a note never opened needs a connection, and offers no offline save', async () => {
    const { vault, connection } = signedIn();
    const { fs, store } = vault.ports.vault;
    const location = await store.read();
    connection.set(false);
    await expect(fs.readTextFile(p('Garden plan.md'))).rejects.toThrow(NOTE_NEEDS_CONNECTION);
    const saving = fs.writeTextFile({
      vault: location!.absolutePath,
      path: p('Garden plan.md'),
      contents: 'offline',
      expectedModified: null,
    });
    await expect(saving).rejects.toThrow(WRITE_NEEDS_CONNECTION);
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
    connection.set(false);
    await expect(fs.readTextFile(p('Garden plan.md'))).rejects.toThrow();
  });
});
