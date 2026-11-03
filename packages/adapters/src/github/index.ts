// The vault as a GitHub repository, for the web build (#664, ADR-0052).
export {
  GITHUB_API_ORIGIN,
  GITHUB_MALFORMED,
  GITHUB_REQUEST_TIMEOUT_MS,
  gitHubApi,
  GitHubRateLimitedError,
  GitHubRefusedError,
  MAX_RATE_LIMIT_WAIT_MS,
  MAX_RATE_LIMIT_WAITS,
} from './github-api.ts';
export type { GitHubApi, GitHubApiDeps, GitHubCall, GitHubToken } from './github-api.ts';
export { gitBranch } from './git-branch.ts';
export type { GitBranch, GitHubVaultRepository } from './git-branch.ts';
export { FOLDER_PLACEHOLDER, gitHubVaultFs } from './github-vault-fs.ts';
export type { GitHubVaultFsDeps } from './github-vault-fs.ts';
export { findGitHubVault, gitHubLogin, gitHubVaultKey } from './github-vault-repository.ts';
export {
  gitHubVaultPorts,
  REMEMBERED_VAULT_KEY,
  rememberedGitHubVault,
} from './github-vault-ports.ts';
export type { RememberedGitHubVault, RememberedVault } from './github-vault-ports.ts';
