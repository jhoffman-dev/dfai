/*
 * The quarantined end-to-end tests (#799): flaky ones tagged `@quarantine`
 * (e2e/quarantine.ts), which the gate leaves out and the non-blocking
 * `quarantine` job runs alone. Each must name an open issue, or it would be
 * left out and forgotten; the job lists them all, with their issues.
 */

/** A quarantined test as the quarantine run left it. */
export interface QuarantinedTest {
  readonly file: string;
  readonly title: string;
  readonly project: string;
  /** The issue its `quarantine` annotation names, if it names one. */
  readonly issue?: number | undefined;
  /** passed, failed, flaky or skipped. */
  readonly outcome: string;
}

const ISSUE_REF = /(?:^|\s)#(\d+)\b|\/issues\/(\d+)\b/;

/** The issue a test's `quarantine` annotation names, as `#812` or the issue's link. */
export function issueOf(
  annotations: readonly { readonly type: string; readonly description?: string }[],
): number | undefined {
  for (const annotation of annotations) {
    if (annotation.type !== 'quarantine') continue;
    const match = ISSUE_REF.exec(annotation.description ?? '');
    if (match !== null) return Number(match[1] ?? match[2]);
  }
  return undefined;
}

/** Playwright's outcome for a test, in the summary's words. */
export function outcomeWord(outcome: string): string {
  const words: Record<string, string> = {
    expected: 'passed',
    unexpected: 'failed',
    flaky: 'flaky',
    skipped: 'skipped',
  };
  return words[outcome] ?? outcome;
}

/** Whether each named issue is open; `undefined` for one that does not exist. */
export type IssueStates = ReadonlyMap<number, boolean | undefined>;

/** What is wrong with the quarantine: a test with no issue, or with one not open. */
export function quarantineProblems(
  tests: readonly QuarantinedTest[],
  states: IssueStates,
): string[] {
  return tests.flatMap((test) => {
    const name = `${test.file} › ${test.title}`;
    if (test.issue === undefined) {
      return [`${name} names no issue: quarantine it with quarantined(<issue>)`];
    }
    const open = states.get(test.issue);
    if (open === undefined) return [`${name} names #${test.issue}, which does not exist`];
    return open ? [] : [`${name} names #${test.issue}, which is closed: fix the test or reopen it`];
  });
}

/** The job's summary: every quarantined test, its issue, and how it did this run. */
export function quarantineSummary(tests: readonly QuarantinedTest[], states: IssueStates): string {
  if (tests.length === 0) return '### Quarantined e2e tests\n\nNone.\n';
  const state = (issue: number | undefined) => {
    if (issue === undefined) return 'none named';
    const open = states.get(issue);
    return `#${issue} (${open === undefined ? 'missing' : open ? 'open' : 'closed'})`;
  };
  const rows = tests.map(
    (test) =>
      `| \`${test.file}\` › ${test.title} | ${test.project} | ${state(test.issue)} | ${test.outcome} |`,
  );
  const problems = quarantineProblems(tests, states);
  return [
    '### Quarantined e2e tests',
    '',
    'Left out of the gate until their issue is fixed. A test that passes here every time may be ready to come back.',
    '',
    '| Test | Project | Issue | This run |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    ...(problems.length === 0 ? [] : ['**Problems**', '', ...problems.map((p) => `- ${p}`), '']),
  ].join('\n');
}
