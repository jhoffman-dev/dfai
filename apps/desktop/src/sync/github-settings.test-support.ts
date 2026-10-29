import type { GitHubSettingsGit } from '@dfai/application';

const OID = 'a'.repeat(40);

/**
 * A vault's git whose `origin/main`, as the last fetch left it, holds this
 * settings note (null: none there), for the gates' read of who GitHub names.
 */
export function githubHolding(settings: () => string | null): GitHubSettingsGit {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  return {
    currentBranch: async () => ok('main\n'),
    tree: async () => ok(settings() === null ? '' : `100644 blob ${OID}\t.atlas/settings.md\0`),
    readBlob: async () => ok(settings() ?? ''),
  };
}
