#!/usr/bin/env node
/*
 * The flake jobs' entry point (#799), run by `node` in the workflows:
 *
 *   flake-job.ts flaky <artifacts folder>       the gate's `flaky` job
 *   flake-job.ts hunt <artifacts folder> <n>    the nightly flake hunt, n repeats
 *   flake-job.ts quarantine <quarantined.json>  the gate's `quarantine` job
 *
 * Issues are filed only with `FILE_ISSUES=true`, which the workflows set only
 * where the token may write: never on a fork's pull request. This reads and
 * prints; flake-jobs.ts decides.
 */
import { readFileSync } from 'node:fs';
import { readShardFlakes, runLinkFromEnv, trackerFromEnv, writeSummary } from './flake-job-io.ts';
import { reportFlakyTests, reportHunt, reportQuarantine, type JobResult } from './flake-jobs.ts';
import type { QuarantinedTest } from './quarantine.ts';

const env = process.env;
const [job, path = '', repeats = '3'] = process.argv.slice(2);
const filer = env.FILE_ISSUES === 'true' ? trackerFromEnv(env) : undefined;

async function run(): Promise<JobResult> {
  if (job === 'flaky') {
    return reportFlakyTests({
      records: readShardFlakes(path),
      run: runLinkFromEnv(env),
      tracker: filer,
    });
  }
  if (job === 'hunt') {
    const records = readShardFlakes(path);
    return reportHunt({
      records,
      run: runLinkFromEnv(env),
      repeats: Number(repeats),
      tracker: filer,
    });
  }
  if (job === 'quarantine') {
    const reader = trackerFromEnv(env);
    if (reader === undefined)
      throw new Error('the quarantine check needs GITHUB_TOKEN to read issues');
    const tests = JSON.parse(readFileSync(path, 'utf8')) as QuarantinedTest[];
    return reportQuarantine({ tests, tracker: reader });
  }
  throw new Error(`unknown job "${job}": flaky, hunt or quarantine`);
}

const result = await run();
writeSummary(result.summary, env);
if (result.failed) process.exitCode = 1;
