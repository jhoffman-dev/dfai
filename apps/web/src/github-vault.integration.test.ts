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
  const authAs = (token: string) =>
    ({
      state: () => state,
      tokenForRequest: async () => token,
      rejected: async () => {},
    }) as unknown as AuthPort;
  const vault = gitHubWebVault({ auth: authAs([...github.tokens][0]!), device });
  return {
    github,
    connection,
    device,
    vault,
    forgotten,
    /** Another person signs in on this device: their own token, their own login. */
    sessionAs: (login: string) => {
      const token = `ghu_${login}`;
      github.tokens.add(token);
      github.logins.set(token, login);
      return gitHubWebVault({ auth: authAs(token), device });
    },
    offline: () => (state = { status: 'signed-out', reason: 'network' }),
  };
}

describe('the web build’s GitHub vault', () => {
  it('forgets the last account’s notes before another account opens, and never shows them', async () => {
    const { vault, device, connection, forgotten, sessionAs } = signedIn();
    await vault.ports.vault.store.read();
    await vault.ports.vault.fs.readTextFile(p('Garden plan.md'));
    await vi.waitFor(async () => expect(await device.cache.facts()).not.toEqual([]));
    // Her session ended on GitHub, so no sign-out ran here; someone else signs in.
    vault.stop();
    const other = sessionAs('tobias-fenn');
    await other.ports.vault.store.read();
    expect(await device.cache.facts()).toEqual([]);
    expect(forgotten).toEqual([gitHubVaultKey(FAKE_VAULT)]);
    expect(device.remembered.read()?.login).toBe('tobias-fenn');
    connection.set(false);
    await expect(other.ports.vault.fs.readTextFile(p('Garden plan.md'))).rejects.toThrow(
      NOTE_NEEDS_CONNECTION,
    );
  });

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
