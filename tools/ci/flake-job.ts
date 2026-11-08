#!/usr/bin/env node
/*
 * The flake jobs' entry point (#799), run by `node` in the workflows:
 *
 *   flake-job.ts flaky <artifacts folder> <shards>             gate.yml's and the macOS nightly's `flaky`
 *   flake-job.ts hunt <artifacts folder> <shards> <repeats>    the nightly flake hunt
 *   flake-job.ts quarantine <listed.json> <ran.json>           gate.yml's `quarantine`
 *
 * <shards> is how many shards must have handed on their flakes: fewer fails
 * the job. Issues are filed only with `FILE_ISSUES=true`, which the workflows
 * set only where the token may write: never on a fork's pull request. This
 * reads and prints; flake-jobs.ts decides.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { IssueTracker } from './flake-issues.ts';
import { readShardFlakes, runLinkFromEnv, trackerFromEnv, writeSummary } from './flake-job-io.ts';
import { reportFlakyTests, reportHunt, reportQuarantine, type JobResult } from './flake-jobs.ts';
import type { QuarantinedTest } from './quarantine.ts';

/** A whole number of at least 1, or a loud refusal naming what it was for. */
export function countArgument(value: string | undefined, what: string): number {
  const count = Number(value);
  if (value === undefined || !/^\d+$/.test(value) || count < 1) {
    throw new Error(`${what} must be a whole number of at least 1, not "${value ?? ''}"`);
  }
  return count;
}

const readTests = (path: string | undefined) =>
  JSON.parse(readFileSync(path ?? '', 'utf8')) as QuarantinedTest[];

export interface FlakeJobOptions {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** GitHub's issues for this environment; injected so a test can stand in for GitHub. */
  readonly trackerFrom?: (env: NodeJS.ProcessEnv) => IssueTracker | undefined;
}

/** Runs one job, writes its summary, and returns the process's exit code. */
export async function runFlakeJob({
  args,
  env,
  trackerFrom = trackerFromEnv,
}: FlakeJobOptions): Promise<number> {
  const result = await jobResult(args, env, trackerFrom);
  writeSummary(result.summary, env);
  return result.failed ? 1 : 0;
}

async function jobResult(
  [job, path, ...counts]: readonly string[],
  env: NodeJS.ProcessEnv,
  trackerFrom: (env: NodeJS.ProcessEnv) => IssueTracker | undefined,
): Promise<JobResult> {
  const filer = env.FILE_ISSUES === 'true' ? trackerFrom(env) : undefined;
  if (job === 'flaky') {
    const records = readShardFlakes(path ?? '', countArgument(counts[0], 'shards'));
    return reportFlakyTests({ records, run: runLinkFromEnv(env), tracker: filer });
  }
  if (job === 'hunt') {
    const records = readShardFlakes(path ?? '', countArgument(counts[0], 'shards'));
    const repeats = countArgument(counts[1], 'repeats');
    return reportHunt({ records, run: runLinkFromEnv(env), repeats, tracker: filer });
  }
  if (job === 'quarantine') {
    const reader = trackerFrom(env);
    if (reader === undefined)
      throw new Error('the quarantine check needs GITHUB_TOKEN to read issues');
    return reportQuarantine({
      listed: readTests(path),
      ran: readTests(counts[0]),
      tracker: reader,
    });
  }
  throw new Error(`unknown job "${job ?? ''}": flaky, hunt or quarantine`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runFlakeJob({ args: process.argv.slice(2), env: process.env });
}
