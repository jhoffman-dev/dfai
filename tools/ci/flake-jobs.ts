import { foldRecords, isFlaky, type FlakeRecord } from './e2e-flakes.ts';
import { fileOrUpdate, type Filed, type IssueTracker } from './flake-issues.ts';
import {
  flakyIssueReport,
  flakyIssueTitle,
  flakySummary,
  huntFindings,
  huntIssueReport,
  type RunLink,
} from './flake-reports.ts';
import { quarantineProblems, quarantineSummary, type QuarantinedTest } from './quarantine.ts';

/*
 * What the three non-blocking flake jobs do with a run's results (#799). Each
 * returns its summary and whether the job should go red. Without a tracker
 * (a fork's pull request, whose token may not write) nothing is filed.
 */

export interface JobResult {
  readonly summary: string;
  readonly failed: boolean;
}

/**
 * The gate's `flaky` job: files each test that failed and then passed its
 * retry, and goes red when there was one, so a flake is seen, not hidden.
 */
export async function reportFlakyTests({
  records,
  run,
  tracker,
}: {
  readonly records: readonly FlakeRecord[];
  readonly run: RunLink;
  readonly tracker?: IssueTracker | undefined;
}): Promise<JobResult> {
  const flaky = records.filter(isFlaky);
  const filed = new Map<string, Filed>();
  const refused: string[] = [];
  for (const record of flaky) {
    if (tracker === undefined) break;
    const title = flakyIssueTitle(record);
    try {
      filed.set(title, await fileOrUpdate(tracker, flakyIssueReport(record, run)));
    } catch (error) {
      // Not thrown on: the other tests still get their issues, the summary
      // says which could not be filed, and the job is red for the flake anyway.
      refused.push(`- could not file ${title}: ${(error as Error).message}`);
    }
  }
  const summary = [flakySummary(flaky, filed), ...refused].join('\n');
  return { summary, failed: flaky.length > 0 };
}

/** The nightly hunt: one issue listing every test that failed a try, if any did. */
export async function reportHunt({
  records,
  run,
  repeats,
  tracker,
}: {
  readonly records: readonly FlakeRecord[];
  readonly run: RunLink;
  readonly repeats: number;
  readonly tracker?: IssueTracker | undefined;
}): Promise<JobResult> {
  const heading = '### Nightly e2e flake hunt\n\n';
  const failing = foldRecords(records);
  if (failing.length === 0) {
    return {
      summary: `${heading}No test failed in ${repeats} runs of the suite.\n`,
      failed: false,
    };
  }
  const filed =
    tracker === undefined
      ? undefined
      : await fileOrUpdate(tracker, huntIssueReport(failing, run, repeats));
  const where =
    filed === undefined ? 'No issue filed.' : `Filed in #${filed.number} (${filed.action}).`;
  return {
    summary: `${heading}${where}\n\n${huntFindings(failing, run, repeats)}\n`,
    failed: false,
  };
}

/** The gate's `quarantine` job: lists every quarantined test, red if one names no open issue. */
export async function reportQuarantine({
  tests,
  tracker,
}: {
  readonly tests: readonly QuarantinedTest[];
  readonly tracker: IssueTracker;
}): Promise<JobResult> {
  const issues = [
    ...new Set(tests.flatMap((test) => (test.issue === undefined ? [] : [test.issue]))),
  ];
  const states = new Map<number, boolean | undefined>();
  for (const issue of issues) states.set(issue, await tracker.isOpen(issue));
  return {
    summary: quarantineSummary(tests, states),
    failed: quarantineProblems(tests, states).length > 0,
  };
}
