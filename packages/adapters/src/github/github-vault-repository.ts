import { VaultAccessError } from '@dfai/application';
import { readInstallationIds, readRepositories } from './github-answers.ts';
import type { GitHubApi } from './github-api.ts';
import type { GitHubVaultRepository } from './git-branch.ts';

/**
 * Which repository is the vault (ADR-0052): the one, and only one, the DFAI
 * App's installation reaches, on its default branch. A token that reaches
 * more than the vault is refused before anything is read, so the web build
 * never writes into a repository the person did not mean as their vault.
 */
export async function findGitHubVault(api: GitHubApi): Promise<GitHubVaultRepository> {
  const installations = readInstallationIds(
    await api.send({ method: 'GET', path: '/user/installations' }),
  );
  if (installations.length === 0)
    throw new VaultAccessError('DFAI is not installed on a GitHub repository yet');
  if (installations.length > 1)
    throw new VaultAccessError('DFAI is installed more than once; keep only the one on your vault');
  const { total, repositories } = readRepositories(
    await api.send({
      method: 'GET',
      path: `/user/installations/${installations[0]}/repositories?per_page=2`,
    }),
  );
  if (total !== 1 || repositories.length !== 1)
    throw new VaultAccessError(
      total === 0
        ? 'DFAI reaches no repository; choose your vault in its settings on GitHub'
        : 'DFAI reaches more than one repository; choose only your vault in its settings on GitHub',
    );
  return repositories[0]!;
}

/** The key every write to this vault names (R14-01). */
export const gitHubVaultKey = ({ owner, repo, branch }: GitHubVaultRepository): string =>
  `github:${owner}/${repo}#${branch}`;
