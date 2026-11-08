import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlakeRecord } from './e2e-flakes.ts';
import type { RunLink } from './flake-reports.ts';
import { GitHubIssues } from './github-issues.ts';

/*
 * The flake jobs' reads and writes (#799): the shards' artifacts, the
 * workflow's environment, the job summary. flake-jobs.ts decides.
 */

/** Each shard's artifact: its flake records, and the link to its report if it uploaded one. */
export const FLAKES_FILE = 'flakes.json';
export const REPORT_URL_FILE = 'report-url.txt';

/** Every shard's records, from the folder the shards' artifacts were downloaded into. */
export function readShardFlakes(folder: string): FlakeRecord[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(folder, entry.name, FLAKES_FILE)))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
    .flatMap((entry) => {
      const shard = join(folder, entry.name);
      const records = JSON.parse(readFileSync(join(shard, FLAKES_FILE), 'utf8')) as FlakeRecord[];
      const urlFile = join(shard, REPORT_URL_FILE);
      const reportUrl = existsSync(urlFile) ? readFileSync(urlFile, 'utf8').trim() : '';
      return reportUrl === '' ? records : records.map((record) => ({ ...record, reportUrl }));
    });
}

/** The run being reported on, from the workflow's environment. */
export function runLinkFromEnv(env: NodeJS.ProcessEnv): RunLink {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = env;
  return {
    url: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT ?? 1}`,
    context: env.RUN_CONTEXT || (env.GITHUB_REF_NAME ?? 'an unknown ref'),
  };
}

/** GitHub's issues with the workflow's token, or none when the job was given no token. */
export function trackerFromEnv(env: NodeJS.ProcessEnv): GitHubIssues | undefined {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY } = env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return undefined;
  return new GitHubIssues({
    apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    repository: GITHUB_REPOSITORY,
    token: GITHUB_TOKEN,
  });
}

/** Prints the summary, and adds it to the job's page when there is one. */
export function writeSummary(summary: string, env: NodeJS.ProcessEnv): void {
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
