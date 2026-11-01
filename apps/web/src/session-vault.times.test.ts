import { createVaultPath, VAULT_WALK_DEPTH } from '@dfai/domain';
import { writtenAt } from '@dfai/application';
import { describe, expect, it } from 'vitest';
import { sessionVaultFs } from './session-vault.ts';

/** #720 (ADR-0053): the session vault counts versions, so it tells no time. */
describe('the session vault’s file times', () => {
  it('reports its count as a version and its time as unknown, on every read', async () => {
    const fs = sessionVaultFs({ 'Welcome.md': '# Welcome\n' });
    const contents = await fs.readTextFile(createVaultPath('Welcome.md'));
    const [file] = await fs.readNotes(['Welcome.md']);
    const [listed] = await fs.listNotes({ skipDirectories: [], maxDepth: VAULT_WALK_DEPTH });
    for (const read of [contents, file!, listed!]) {
      expect(read.modified).toBe(1);
      expect(writtenAt(read)).toBeNull();
    }
  });
});
