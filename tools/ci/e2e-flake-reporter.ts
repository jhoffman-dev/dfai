import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FullConfig, Reporter, Suite, TestCase } from '@playwright/test/reporter';
import { flakeRecordsOf, type RanTest } from './e2e-flakes.ts';
import { pathFrom, projectOf, repositoryRoot, titleOf } from './playwright-tests.ts';

/*
 * A Playwright reporter for CI (#799) that writes, to the file
 * `E2E_FLAKES_OUT` names, every test that failed on at least one try: the
 * gate's shards, where a failure is retried once, and the nightly flake hunt,
 * where the suite repeats. It writes the file, `[]` when nothing failed, so
 * every shard hands on a result. Without `E2E_FLAKES_OUT` it does nothing.
 */
export default class E2eFlakeReporter implements Reporter {
  private root = process.cwd();
  private suite: Suite | undefined;

  onBegin(config: FullConfig, suite: Suite): void {
    this.root = repositoryRoot(config);
    this.suite = suite;
  }

  onEnd(): void {
    const out = process.env.E2E_FLAKES_OUT;
    if (out === undefined || out === '' || this.suite === undefined) return;
    const records = flakeRecordsOf(this.suite.allTests().map((test) => this.ranTestOf(test)));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(records, null, 2)}\n`);
  }

  printsToStdio(): boolean {
    return false;
  }

  private ranTestOf(test: TestCase): RanTest {
    return {
      file: pathFrom(this.root, test.location.file),
      title: titleOf(test),
      project: projectOf(test),
      expectedStatus: test.expectedStatus,
      results: test.results,
    };
  }
}
