import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MoveRefusedError, VaultAccessError } from '@dfai/application';
import { createVaultPath } from '@dfai/domain';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { tauriVaultFs } = await import('./tauri-vault-fs.ts');

/*
 * Second attack on PR #684: the adapter putting two host refusals in the
 * domain's words. `it.fails` marks a finding.
 */
describe('tauriVaultFs.moveEntry refusals (PR #684, attack 2)', () => {
  const notes = createVaultPath('Projects');
  const refuse = (message: string) => {
    invoke.mockImplementation(() => Promise.reject(message));
    return tauriVaultFs.moveEntry({ from: notes, to: notes, vault: '/a' });
  };

  beforeEach(() => {
    invoke.mockReset();
  });

  /*
   * A link may be named anything the disk allows; `a\b` is a fine macOS name
   * (the host test `a_refused_link_is_named_as_it_is_spelled_even_with_a_backslash`
   * shows the host naming it so). `createVaultPath` rejects a backslash, so the
   * refusal arrives as an InvalidVaultPathError about a path, not as the
   * refusal, and the notice shows neither the host's words nor the domain's.
   */
  it.fails(
    'still says a link would be re-pointed when the link has a backslash in its name',
    async () => {
      await expect(refuse('moving it would point a link elsewhere: Projects/a\\b')).rejects.toThrow(
        MoveRefusedError,
      );
    },
  );

  it('leaves a host error that only mentions a refusal mid-sentence as the host said it', async () => {
    const message = 'cannot move: path goes through a link: Work/Alias';
    await expect(refuse(message)).rejects.toThrow(new VaultAccessError(message));
  });

  it('leaves the unreadable-folder refusal as the host said it, naming the folder', async () => {
    const message = 'cannot check the links inside Projects/Locked: permission denied';
    await expect(refuse(message)).rejects.toThrow(new VaultAccessError(message));
  });

  it('does not take a refusal in another case as the domain’s', async () => {
    const message = 'Path goes through a link: Work/Alias';
    await expect(refuse(message)).rejects.toThrow(new VaultAccessError(message));
  });
});
