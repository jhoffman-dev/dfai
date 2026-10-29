import type { GitHubSettingsGit } from '@dfai/application';

/**
 * A vault's git whose `origin/main`, as the last fetch left it, holds this
 * settings note (null: none there), for the gates' read of who GitHub names.
 */
export function githubHolding(settings: () => string | null): GitHubSettingsGit {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  return {
    currentBranch: async () => ok('main\n'),
    remoteSettings: async (branch) => {
      const text = settings();
      return text === null
        ? {
            code: 128,
            stdout: '',
            stderr: `fatal: path '.atlas/settings.md' does not exist in 'origin/${branch}'`,
          }
        : ok(text);
    },
  };
}
