import type { GitHubSettingsGit } from '@dfai/application';

/**
 * A vault's git whose `origin/main`, as the last fetch left it, holds this
 * settings note (null: none there), for the gates' read of who GitHub names.
 */
export function githubHolding(settings: () => string | null): GitHubSettingsGit {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  return {
    currentBranch: async () => ok('main\n'),
    remoteBranchExists: async () => ok(`${'f'.repeat(40)}\n`),
    remoteSettingsExist: async () =>
      settings() === null ? { code: 1, stdout: '', stderr: '' } : ok(''),
    remoteSettings: async () => ok(settings() ?? ''),
  };
}
