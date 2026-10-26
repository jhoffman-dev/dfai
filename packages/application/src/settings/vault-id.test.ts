import { describe, expect, it } from 'vitest';
import { jsonMarkdown, vaultWith } from '../testing/settings-vault.ts';
import { readVaultId, vaultIdChange } from './vault-id.ts';

const SETTINGS = '.atlas/settings.md';
const rng = { next: () => 0.5 };

describe('readVaultId', () => {
  it('is the id the settings hold, or null when they hold none, and never writes one', async () => {
    const held = vaultWith({ [SETTINGS]: '---\n{"vault_id":"p8r2s6u0c4f1g9j7"}\n---\n' });
    expect(await readVaultId({ fs: held.fs, markdown: jsonMarkdown() })).toBe('p8r2s6u0c4f1g9j7');
    const none = vaultWith({ [SETTINGS]: '---\n{}\n---\n' });
    expect(await readVaultId({ fs: none.fs, markdown: jsonMarkdown() })).toBeNull();
    expect(none.written).toEqual({ [SETTINGS]: '---\n{}\n---\n' });
  });

  it('refuses a value that is not text', async () => {
    const { fs } = vaultWith({ [SETTINGS]: '---\n{"vault_id":7}\n---\n' });
    await expect(readVaultId({ fs, markdown: jsonMarkdown() })).rejects.toThrow('vault_id');
  });
});

describe('vaultIdChange', () => {
  it('gives an id only to a vault with none, and never replaces one, even one that is not text', () => {
    expect(vaultIdChange({}, rng)).toEqual({ vault_id: 'gggggggggggggggg' });
    expect(vaultIdChange({ vault_id: 'p8r2s6u0c4f1g9j7' }, rng)).toEqual({});
    expect(vaultIdChange({ vault_id: 7 }, rng)).toEqual({});
  });
});
