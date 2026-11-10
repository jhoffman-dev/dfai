import type { IssueFacts } from './flake-issues.ts';
import { inert } from './inert-markdown.ts';

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
  /** passed, failed, flaky or skipped; or why it did not run here. */
  readonly outcome: string;
  /** Tagged `@mac` too: it runs only on macOS, in the macOS nightly. */
  readonly macOnly?: boolean | undefined;
}

/** The label a quarantine's issue must carry: a flaky-test issue, not any open one. */
export const QUARANTINE_LABEL = 'flaky';

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

/** Each named issue's state and labels; `undefined` for none, or a pull request. */
export type IssueStates = ReadonlyMap<number, IssueFacts | undefined>;

const sameTest = (a: QuarantinedTest, b: QuarantinedTest) =>
  a.file === b.file && a.title === b.title && a.project === b.project;

/**
 * Every quarantined test, from the listing that sees every platform's, with
 * how it did where the Linux run ran it. A `@mac` one is listed and its issue
 * checked here though it can only run in the macOS nightly (PR #802's review).
 */
export function quarantineOf(
  listed: readonly QuarantinedTest[],
  ran: readonly QuarantinedTest[],
): QuarantinedTest[] {
  return listed.map((test) => {
    const result = ran.find((other) => sameTest(test, other));
    if (result !== undefined) return { ...test, outcome: result.outcome };
    return {
      ...test,
      outcome: test.macOnly ? 'macOS only: runs in the macOS nightly' : 'did not run',
    };
  });
}

/** What is wrong with one test's issue, if anything. */
function issueProblem(issue: number, facts: IssueFacts | undefined): string | undefined {
  if (facts === undefined) return `names #${issue}, which is no issue (missing, or a pull request)`;
  if (!facts.open) return `names #${issue}, which is closed: fix the test or reopen it`;
  if (!facts.labels.includes(QUARANTINE_LABEL)) {
    return `names #${issue}, which is not labelled ${QUARANTINE_LABEL}: name the test's own flaky issue`;
  }
  return undefined;
}

/**
 * What is wrong with the quarantine: a test that names no issue, or one that
 * is not an open `flaky` issue, so neither an epic nor a pull request can keep
 * a test out of the gate for good (PR #802's attack).
 */
export function quarantineProblems(
  tests: readonly QuarantinedTest[],
  states: IssueStates,
): string[] {
  return tests.flatMap((test) => {
    const name = `${test.file} › ${test.title}`;
    if (test.issue === undefined) {
      return [`${name} names no issue: quarantine it with quarantined(<issue>)`];
    }
    const problem = issueProblem(test.issue, states.get(test.issue));
    return problem === undefined ? [] : [`${name} ${problem}`];
  });
}

function issueCell(issue: number | undefined, states: IssueStates): string {
  if (issue === undefined) return 'none named';
  const facts = states.get(issue);
  if (facts === undefined) return `#${issue} (no issue)`;
  const flaky = facts.labels.includes(QUARANTINE_LABEL) ? '' : `, not ${QUARANTINE_LABEL}`;
  return `#${issue} (${facts.open ? 'open' : 'closed'}${flaky})`;
}

/** The job's summary: every quarantined test, its issue, and how it did this run. */
export function quarantineSummary(tests: readonly QuarantinedTest[], states: IssueStates): string {
  if (tests.length === 0) return '### Quarantined e2e tests\n\nNone.\n';
  const rows = tests.map(
    (test) =>
      `| ${inert(test.file)} › ${inert(test.title)} | ${inert(test.project)} | ${issueCell(test.issue, states)} | ${inert(test.outcome)} |`,
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
    ...(problems.length === 0
      ? []
      : ['**Problems**', '', ...problems.map((p) => `- ${inert(p)}`), '']),
  ].join('\n');
}
