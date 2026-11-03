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

function ports(storage = memoryStorage()) {
  const github = new FakeGitHub({ files: { 'Plan.md': '# Plan\n' } });
  const { api } = vaultOver(github);
  const remembered = rememberedGitHubVault(storage);
  return { github, storage, remembered, ...gitHubVaultPorts({ api, remembered }) };
}

describe('gitHubVaultPorts', () => {
  it('finds the vault the first time, remembers it, and reads it', async () => {
    const { store, fs, remembered } = ports();
    expect(await store.read()).toEqual({
      absolutePath: gitHubVaultKey(FAKE_VAULT),
      name: FAKE_VAULT.repo,
    });
    expect(remembered.read()).toEqual(FAKE_VAULT);
    expect((await fs.readTextFile(p('Plan.md'))).text).toBe('# Plan\n');
  });

  it('answers the remembered vault without asking GitHub', async () => {
    const storage = memoryStorage();
    storage.setItem(REMEMBERED_VAULT_KEY, JSON.stringify(FAKE_VAULT));
    const { store, github } = ports(storage);
    expect((await store.read())?.absolutePath).toBe(gitHubVaultKey(FAKE_VAULT));
    expect(github.received).toEqual([]);
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
  });
});
