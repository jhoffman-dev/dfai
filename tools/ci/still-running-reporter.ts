import { writeSync } from 'node:fs';
import type { Reporter, TestCase, TestModule } from 'vitest/node';

/*
 * A Vitest reporter for the CI shards (.github/workflows/gate.yml, the `unit`
 * jobs) that names what was still running when the run was stopped (#737).
 *
 * A shard once hung until the job's limit, and the log said nothing of which
 * test: the default reporter prints a file only once it ends. The shard's step
 * stops Vitest with SIGTERM before the job's limit, and this prints the files
 * and tests that had started and not finished. A worker stuck in a synchronous
 * loop cannot send which test it began, so for that hang only the file shows.
 */

/** What had started and not ended, keyed by file then by test. */
export class StillRunning {
  private readonly files = new Map<string, Set<string>>();

  fileStarted(file: string): void {
    this.files.set(file, new Set());
  }

  fileEnded(file: string): void {
    this.files.delete(file);
  }

  testStarted(file: string, test: string): void {
    this.files.get(file)?.add(test);
  }

  testEnded(file: string, test: string): void {
    this.files.get(file)?.delete(test);
  }

  /** The report to print, or '' when nothing is running. */
  describe(): string {
    if (this.files.size === 0) return '';
    const lines = ['Still running when the run was stopped:'];
    for (const [file, tests] of this.files) {
      lines.push(`  ${file}`, ...[...tests].map((test) => `    > ${test}`));
    }
    return `${lines.join('\n')}\n`;
  }
}

/** The signals the step's `timeout` (and the runner, on cancel) stops Vitest with. */
const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export default class StillRunningReporter implements Reporter {
  private readonly running = new StillRunning();

  private readonly onStop = (): void => {
    // Written synchronously: Vitest exits a moment after the same signal.
    const report = this.running.describe();
    if (report) writeSync(process.stderr.fd, report);
  };

  onInit(): void {
    for (const signal of STOP_SIGNALS) process.once(signal, this.onStop);
  }

  onTestRunEnd(): void {
    for (const signal of STOP_SIGNALS) process.off(signal, this.onStop);
  }

  onTestModuleStart(testModule: TestModule): void {
    this.running.fileStarted(testModule.relativeModuleId);
  }

  onTestModuleEnd(testModule: TestModule): void {
    this.running.fileEnded(testModule.relativeModuleId);
  }

  onTestCaseReady(testCase: TestCase): void {
    this.running.testStarted(testCase.module.relativeModuleId, testCase.fullName);
  }

  onTestCaseResult(testCase: TestCase): void {
    this.running.testEnded(testCase.module.relativeModuleId, testCase.fullName);
  }
}
