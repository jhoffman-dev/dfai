import { createVaultPath as p } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import { FAKE_VAULT, FakeGitHub } from './fake-github.test-support.ts';
import {
  gitHubVaultPorts,
  REMEMBERED_VAULT_KEY,
  rememberedGitHubVault,
} from './github-vault-ports.ts';
import { vaultOver } from './github-vault.test-support.ts';
import { gitHubVaultKey } from './github-vault-repository.ts';

function memoryStorage(): Storage {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
  } as Storage;
}

function ports(
  storage = memoryStorage(),
  github = new FakeGitHub({ files: { 'Plan.md': '# Plan\n' } }),
) {
  const { api } = vaultOver(github);
  const remembered = rememberedGitHubVault(storage);
  const switches: string[] = [];
  const beforeOpen = async (previous: { login: string }, login: string) => {
    switches.push(`${previous.login} -> ${login}`);
    remembered.forget();
  };
  return {
    github,
    storage,
    remembered,
    switches,
    ...gitHubVaultPorts({ api, remembered, beforeOpen }),
  };
}

describe('gitHubVaultPorts', () => {
  it('finds the vault the first time, remembers it, and reads it', async () => {
    const { store, fs, remembered } = ports();
    expect(await store.read()).toEqual({
      absolutePath: gitHubVaultKey(FAKE_VAULT),
      name: FAKE_VAULT.repo,
    });
    expect(remembered.read()).toEqual({ ...FAKE_VAULT, login: 'mara-quill' });
    expect((await fs.readTextFile(p('Plan.md'))).text).toBe('# Plan\n');
  });

  it('unconfirms the login when GitHub, asked again, says someone else or cannot be asked', async () => {
    const { store, signedIn, confirmAgain, github } = ports();
    expect(await confirmAgain()).toBeNull();
    await store.read();
    expect(await confirmAgain()).toBe('mara-quill');
    github.intercept(
      (request) => request.path === '/user',
      () => Promise.reject(new TypeError('Failed to fetch')),
    );
    expect(await confirmAgain()).toBeNull();
    expect(signedIn()).toBeNull();
  });

  it('knows who is signed in only once GitHub said so and the vault opened', async () => {
    const { store, signedIn } = ports();
    expect(signedIn()).toBeNull();
    await store.read();
    expect(signedIn()).toBe('mara-quill');
  });

  it('answers the remembered vault without asking GitHub', async () => {
    const storage = memoryStorage();
    storage.setItem(REMEMBERED_VAULT_KEY, JSON.stringify({ ...FAKE_VAULT, login: 'mara-quill' }));
    const { store, github, switches } = ports(storage);
    expect((await store.read())?.absolutePath).toBe(gitHubVaultKey(FAKE_VAULT));
    // Only who is signed in is asked: the vault is the one remembered.
    expect(github.received.map((call) => call.path)).toEqual(['/user']);
    expect(switches).toEqual([]);
  });

  it('lets the previous account go before another account opens the vault', async () => {
    const storage = memoryStorage();
    storage.setItem(REMEMBERED_VAULT_KEY, JSON.stringify({ ...FAKE_VAULT, login: 'tobias-fenn' }));
    const { store, switches, remembered } = ports(storage);
    await store.read();
    expect(switches).toEqual(['tobias-fenn -> mara-quill']);
    expect(remembered.read()?.login).toBe('mara-quill');
  });

  it('opens nothing when the switch is refused', async () => {
    const storage = memoryStorage();
    storage.setItem(REMEMBERED_VAULT_KEY, JSON.stringify({ ...FAKE_VAULT, login: 'tobias-fenn' }));
    const github = new FakeGitHub({ files: { 'Plan.md': '# Plan\n' } });
    const { api } = vaultOver(github);
    const remembered = rememberedGitHubVault(storage);
    const { store } = gitHubVaultPorts({
      api,
      remembered,
      beforeOpen: async () => Promise.reject(new Error('saves wait')),
    });
    await expect(store.read()).rejects.toThrow('saves wait');
    expect(remembered.read()?.login).toBe('tobias-fenn');
  });

  it('opens the remembered vault when who is signed in cannot be asked, offline', async () => {
    const storage = memoryStorage();
    storage.setItem(REMEMBERED_VAULT_KEY, JSON.stringify({ ...FAKE_VAULT, login: 'mara-quill' }));
    const github = new FakeGitHub({ files: {} });
    const { api } = vaultOver(github, {
      fetch: () => Promise.reject(new TypeError('Load failed')),
    });
    const { store } = gitHubVaultPorts({
      api,
      remembered: rememberedGitHubVault(storage),
      beforeOpen: async () => {},
    });
    expect((await store.read())?.absolutePath).toBe(gitHubVaultKey(FAKE_VAULT));
  });

  it('refuses every read once the vault is forgotten', async () => {
    const { store, fs, remembered } = ports();
    await store.read();
    remembered.forget();
    await expect(fs.listDirectory(p('Garden'))).rejects.toThrow('no vault is open');
  });

  it('remembers nothing it did not write: not JSON, or not a repository', () => {
    const storage = memoryStorage();
    const remembered = rememberedGitHubVault(storage);
    storage.setItem(REMEMBERED_VAULT_KEY, '{not json');
    expect(remembered.read()).toBeNull();
    storage.setItem(REMEMBERED_VAULT_KEY, JSON.stringify({ owner: 'a', repo: 1 }));
    expect(remembered.read()).toBeNull();
    // Remembered before accounts were: whose it was is unknown, so it is not this one's.
    storage.setItem(REMEMBERED_VAULT_KEY, JSON.stringify(FAKE_VAULT));
    expect(remembered.read()).toBeNull();
  });
});
