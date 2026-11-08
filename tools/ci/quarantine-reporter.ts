import { writeFileSync } from 'node:fs';
import type { FullConfig, Reporter, Suite, TestCase } from '@playwright/test/reporter';
import { QUARANTINE_TAG } from './e2e-tags.ts';
import { pathFrom, projectOf, repositoryRoot, titleOf } from './playwright-tests.ts';
import { issueOf, outcomeWord, type QuarantinedTest } from './quarantine.ts';

/*
 * A Playwright reporter for the gate's `quarantine` job (#799): writes every
 * `@quarantine` test the run had, the issue it names and how it did, to the
 * file `E2E_QUARANTINE_OUT` names, for flake-job.ts to check and list. Run
 * with `--list` and `E2E_QUARANTINE=list`, it writes every platform's.
 */
export default class QuarantineReporter implements Reporter {
  private root = process.cwd();
  private suite: Suite | undefined;

  onBegin(config: FullConfig, suite: Suite): void {
    this.root = repositoryRoot(config);
    this.suite = suite;
  }

  onEnd(): void {
    const out = process.env.E2E_QUARANTINE_OUT;
    if (out === undefined || out === '' || this.suite === undefined) return;
    const tests = this.suite
      .allTests()
      .filter((test) => test.tags.includes(QUARANTINE_TAG))
      .map((test) => this.quarantinedOf(test));
    writeFileSync(out, `${JSON.stringify(tests, null, 2)}\n`);
  }

  printsToStdio(): boolean {
    return false;
  }

  private quarantinedOf(test: TestCase): QuarantinedTest {
    return {
      file: pathFrom(this.root, test.location.file),
      title: titleOf(test),
      project: projectOf(test),
      issue: issueOf(test.annotations),
      outcome: outcomeWord(test.outcome()),
      ...(test.tags.includes('@mac') ? { macOnly: true } : {}),
    };
  }
}
