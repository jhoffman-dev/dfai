/**
 * Reading a vault's rules (`loadAutomations`): it runs on every minute's tick
 * while a vault is open, so a vault with no rules must not cost a host call.
 */
import { describe, expect, it } from 'vitest';
import { automationVault } from '../testing/automation-vault.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { loadAutomations } from './load-automations.ts';

/** The vault's files, with every batch `readNotes` was asked for. */
function countedReads(fs: VaultFsPort) {
  const asked: (readonly string[])[] = [];
  const counted: VaultFsPort = {
    ...fs,
    readNotes: (paths) => {
      asked.push(paths);
      return fs.readNotes(paths);
    },
  };
  return { fs: counted, asked };
}

describe('loadAutomations', () => {
  it('reads nothing from the vault when it has no rule files', async () => {
    const vault = automationVault({
      today: '2026-09-27',
      notes: { 'Areas/Garden.md': '# Garden\n' },
    });
    const { fs, asked } = countedReads(vault.ports.fs);
    const listing = await loadAutomations({
      fs,
      markdown: vault.ports.markdown,
      notePaths: vault.ports.notePaths,
    });
    expect(listing).toEqual({ automations: [], broken: [] });
    expect(asked).toEqual([]);
  });
});
