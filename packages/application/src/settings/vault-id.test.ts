import { describe, expect, it } from 'vitest';
import { jsonMarkdown, vaultWith } from '../testing/settings-vault.ts';
import type { SettingsWriter } from './settings-writer.ts';
import { ensureVaultId } from './vault-id.ts';

const SETTINGS = '.atlas/settings.md';
const rng = { next: () => 0.5 };

/** A writer whose turn comes after another write changed the settings to `meanwhile`. */
function writerAfter(meanwhile: Record<string, unknown>) {
  const asked: Readonly<Record<string, unknown>>[] = [];
  const settings: SettingsWriter = {
    save: async () => undefined,
    update: async (change) => {
      asked.push(change(meanwhile));
    },
  };
  return { settings, asked };
}

describe('ensureVaultId', () => {
  it('keeps an id another write gave the vault between the read and its turn', async () => {
    const { fs } = vaultWith({});
    const { settings, asked } = writerAfter({ vault_id: 'p8r2s6u0c4f1g9j7' });
    const id = await ensureVaultId({ fs, markdown: jsonMarkdown(), settings, rng });
    expect(id).toBe('p8r2s6u0c4f1g9j7');
    expect(asked).toEqual([{}]);
  });

  it('refuses, writing nothing, when another write left a value that is not text', async () => {
    const { fs } = vaultWith({});
    const { settings, asked } = writerAfter({ vault_id: 7 });
    await expect(ensureVaultId({ fs, markdown: jsonMarkdown(), settings, rng })).rejects.toThrow(
      'vault_id',
    );
    expect(asked).toEqual([{}]);
  });

  it('asks before it writes, so a stopped caller writes nothing', async () => {
    const { fs } = vaultWith({ [SETTINGS]: '---\n{}\n---\n' });
    const { settings, asked } = writerAfter({});
    const stop = new Error('stopped');
    await expect(
      ensureVaultId({
        fs,
        markdown: jsonMarkdown(),
        settings,
        rng,
        beforeWrite: () => {
          throw stop;
        },
      }),
    ).rejects.toBe(stop);
    expect(asked).toEqual([]);
  });
});
