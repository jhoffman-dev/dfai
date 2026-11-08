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
  addSubIssue(parentNumber: number, child: TrackedIssue): Promise<void>;
  /** Whether the issue is open; `undefined` when there is no such issue. */
  isOpen(issueNumber: number): Promise<boolean | undefined>;
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
}

/** Opens the report's issue, or comments on the one already filed, reopening it if closed. */
export async function fileOrUpdate(tracker: IssueTracker, report: IssueReport): Promise<Filed> {
  const existing = await tracker.findByTitle(report.title, FLAKY_LABEL);
  if (existing === undefined) {
    const opened = await tracker.create({
      title: report.title,
      body: report.body,
      labels: [FLAKY_LABEL],
    });
    await tracker.addSubIssue(FLAKE_EPIC, opened);
    return { number: opened.number, action: 'opened' };
  }
  if (!existing.open) await tracker.reopen(existing.number);
  await tracker.comment(existing.number, report.comment);
  return { number: existing.number, action: existing.open ? 'commented' : 'reopened' };
}
