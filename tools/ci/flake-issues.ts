/*
 * Filing an unreliable test where it cannot be forgotten (#799): one GitHub
 * issue per title, labelled `flaky` and a sub-issue of the test-reliability
 * epic. A test that flakes again updates its issue rather than opening a
 * second one, and reopens it if it was closed as fixed.
 *
 * `IssueTracker` is the port; github-issues.ts is its adapter.
 */

export const FLAKY_LABEL = 'flaky';
/** The epic every flaky-test issue sits under: "Test and CI reliability". */
export const FLAKE_EPIC = 126;

export interface TrackedIssue {
  readonly number: number;
  /** GitHub's id for the issue, which the sub-issue API takes, not its number. */
  readonly id: number;
  readonly open: boolean;
}

export interface IssueTracker {
  /** The issue with exactly this title and label, an open one before a closed one. */
  findByTitle(title: string, label: string): Promise<TrackedIssue | undefined>;
  create(issue: {
    readonly title: string;
    readonly body: string;
    readonly labels: readonly string[];
  }): Promise<TrackedIssue>;
  comment(issueNumber: number, body: string): Promise<void>;
  reopen(issueNumber: number): Promise<void>;
  /** Puts `child` under `parentNumber`, unless it is there already. */
  addSubIssue(parentNumber: number, child: TrackedIssue): Promise<void>;
  /** The issue's state and labels; `undefined` when there is no such issue, or it is a pull request. */
  findIssue(issueNumber: number): Promise<IssueFacts | undefined>;
}

export interface IssueFacts {
  readonly open: boolean;
  readonly labels: readonly string[];
}

/** What to file: the body of a new issue, or the comment that updates one. */
export interface IssueReport {
  readonly title: string;
  readonly body: string;
  readonly comment: string;
}

export interface Filed {
  readonly number: number;
  readonly action: 'opened' | 'commented' | 'reopened';
  /** Why the issue is not under the epic yet, when linking it failed; the next flake tries again. */
  readonly unlinked?: string;
}

/**
 * Opens the report's issue, or comments on the one already filed, reopening it
 * if closed; then makes sure it sits under the epic. Every flake retries that
 * link, so one that failed once is not left out for good (PR #802's attack),
 * and a failed link does not make the filed issue read as not filed.
 */
export async function fileOrUpdate(tracker: IssueTracker, report: IssueReport): Promise<Filed> {
  const filed = await openOrComment(tracker, report);
  try {
    await tracker.addSubIssue(FLAKE_EPIC, filed.issue);
    return filed.result;
  } catch (error) {
    return { ...filed.result, unlinked: (error as Error).message };
  }
}

async function openOrComment(
  tracker: IssueTracker,
  report: IssueReport,
): Promise<{ issue: TrackedIssue; result: Filed }> {
  const existing = await tracker.findByTitle(report.title, FLAKY_LABEL);
  if (existing === undefined) {
    const opened = await tracker.create({
      title: report.title,
      body: report.body,
      labels: [FLAKY_LABEL],
    });
    return { issue: opened, result: { number: opened.number, action: 'opened' } };
  }
  if (!existing.open) await tracker.reopen(existing.number);
  await tracker.comment(existing.number, report.comment);
  const action = existing.open ? 'commented' : 'reopened';
  return { issue: existing, result: { number: existing.number, action } };
}
