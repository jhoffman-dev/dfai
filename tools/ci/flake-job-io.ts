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

/** Beside each shard's records: which shard it was, of how many (the flake reporter's `--shard`). */
export const SHARD_FILE = 'shard.json';

interface ShardOf {
  readonly current: number;
  readonly total: number;
}

function shardOf(folder: string): ShardOf {
  const file = join(folder, SHARD_FILE);
  if (!existsSync(file))
    throw new Error(`${folder} has no ${SHARD_FILE}: which shard it was is unknown`);
  return JSON.parse(readFileSync(file, 'utf8')) as ShardOf;
}

/**
 * Checks the shards that reported are exactly shards 1 to n of one run of n.
 * The count comes from the shards themselves (`--shard=i/n`, n the matrix's
 * size), so a grown matrix whose new shard died reads as missing, never as
 * "no flakes" (PR #802's review).
 */
function checkEveryShard(shards: readonly ShardOf[]): void {
  const totals = new Set(shards.map((shard) => shard.total));
  if (totals.size !== 1) {
    throw new Error(`the shards disagree on how many there were: ${[...totals].join(', ')}`);
  }
  const total = shards[0]!.total;
  const seen = new Set(shards.map((shard) => shard.current));
  const missing = Array.from({ length: total }, (_, at) => at + 1).filter((n) => !seen.has(n));
  if (missing.length > 0 || shards.length !== total) {
    throw new Error(
      `${shards.length} of ${total} shards handed on their flakes; missing: ` +
        `${missing.join(', ') || 'none'}: the rest died before reporting`,
    );
  }
}

/**
 * Every shard's records, from the folder the shards' artifacts were downloaded
 * into. Each shard's reporter writes its records, `[]` when nothing failed, so
 * a missing folder or shard means a shard died before it reported, not that
 * nothing failed: that throws (PR #802's attack), naming which.
 */
export function readShardFlakes(folder: string): FlakeRecord[] {
  if (!existsSync(folder)) {
    throw new Error(
      `no shard handed on its flakes (${folder} is missing): read as unknown, not none`,
    );
  }
  const shards = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(folder, entry.name, FLAKES_FILE)))
    .map((entry) => join(folder, entry.name));
  if (shards.length === 0) throw new Error(`no shard's flakes in ${folder}`);
  const read = shards
    .map((shard) => ({ shard, of: shardOf(shard) }))
    .sort((a, b) => a.of.current - b.of.current);
  checkEveryShard(read.map(({ of }) => of));
  return read.flatMap(({ shard }) => {
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
