import type { Clock } from '@dfai/application';
import { gitHubApi, type GitHubApiDeps, type GitHubToken } from './github-api.ts';
import { gitBranch } from './git-branch.ts';
import { gitHubVaultFs } from './github-vault-fs.ts';
import { gitHubVaultKey } from './github-vault-repository.ts';
import type { FakeGitHub } from './fake-github.test-support.ts';
import { FAKE_TOKEN } from './fake-github.test-support.ts';

/** A fixed now, 2026-11-01T12:00:00Z: rate limits are measured against it. */
export const NOW = Date.UTC(2026, 10, 1, 12);
export const fixedClock: Pick<Clock, 'now'> = { now: () => NOW };
/** A timeout that never fires unless a test fires it. */
export const neverTimesOut = () => new Promise<void>(() => undefined);

/** The sign-in, as a test holds it: the token it hands out, and each 401 reported. */
export function tokenSource(github: FakeGitHub, first = FAKE_TOKEN) {
  const rejected: string[] = [];
  let current = first;
  const token: GitHubToken = {
    tokenForRequest: async () => current,
    rejected: async (accessToken) => {
      rejected.push(accessToken);
      current = `ghu_refreshed-${rejected.length}`;
      github.tokens.add(current);
    },
  };
  return { token, rejected };
}

/** The GitHub vault over the stand-in, with every dependency a test may replace. */
export function vaultOver(github: FakeGitHub, deps: Partial<GitHubApiDeps> = {}) {
  const waits: number[] = [];
  const api = gitHubApi({
    fetch: github.fetch,
    token: tokenSource(github).token,
    clock: fixedClock,
    wait: async (ms) => {
      waits.push(ms);
    },
    timeout: neverTimesOut,
    ...deps,
  });
  const vault = gitHubVaultKey(github.where);
  return { fs: gitHubVaultFs({ branch: gitBranch(api, github.where), vault }), vault, api, waits };
}
