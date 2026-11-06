import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type {
  FullConfig,
  Reporter,
  Suite,
  TestCase,
  TestResult,
  TestRun,
} from '@playwright/test/reporter';
import { durationsOf, type TestTime } from './e2e-shards.ts';
import { filesOfShard, type Durations } from './unit-shards.ts';

/*
 * A Playwright reporter that does the gate's e2e sharding (#716): with
 * `--shard=n/count`, it takes the deal from Playwright and keeps only the spec
 * files unit-shards.ts deals to shard n by their recorded durations
 * (e2e-durations.json). A file stays whole on one shard, so a serial file's
 * tests keep their order and their worker; inside the shard `fullyParallel`
 * still spreads its tests over the workers.
 *
 * Every shard works the same deal out from the same suite and the same
 * durations, so each file runs on exactly one. A new file costs only the
 * start: a stale record skews the balance, never what runs.
 *
 * With `E2E_DURATIONS_OUT` set, it also writes what this shard's files took
 * there, for e2e-durations.mjs to put together when the shards drift.
 */

const DURATIONS_FILE = new URL('./e2e-durations.json', import.meta.url);

function recordedDurations(): Durations {
  const { files } = JSON.parse(readFileSync(DURATIONS_FILE, 'utf8')) as { files: Durations };
  return files;
}

/**
 * Where the durations' paths start: the config file's folder, the
 * repository's root. Not `config.rootDir`, which is the test folder (`e2e`):
 * keyed from there, no file matched its record and every file cost the same.
 */
function repositoryRoot(config: FullConfig): string {
  return config.configFile === undefined ? process.cwd() : dirname(config.configFile);
}

export default class E2eShardReporter implements Reporter {
  private root = process.cwd();
  private readonly times: TestTime[] = [];

  preprocess({
    config,
    suite,
    testRun,
  }: {
    config: FullConfig;
    suite: Suite;
    testRun: TestRun;
  }): Promise<void> {
    this.root = repositoryRoot(config);
    if (config.shard === null) return Promise.resolve();
    testRun.skipSharding();
    const fileSuites = suite.suites.flatMap((project) => project.suites);
    const files = fileSuites.map((file) => this.pathOf(file.location?.file ?? file.title));
    const mine = new Set(
      filesOfShard(files, recordedDurations(), {
        index: config.shard.current,
        count: config.shard.total,
      }),
    );
    fileSuites.forEach((file, at) => {
      if (!mine.has(files[at]!)) testRun.exclude(file);
    });
    return Promise.resolve();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.times.push({ file: this.pathOf(test.location.file), ms: result.duration });
  }

  onEnd(): void {
    const out = process.env.E2E_DURATIONS_OUT;
    if (out === undefined || out === '') return;
    writeFileSync(out, `${JSON.stringify(durationsOf(this.times), null, 2)}\n`);
  }

  printsToStdio(): boolean {
    return false;
  }

  private pathOf(file: string): string {
    return relative(this.root, file).split('\\').join('/');
  }
}
