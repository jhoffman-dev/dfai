import type { IssueTracker, TrackedIssue } from './flake-issues.ts';

/*
 * An in-memory GitHub for the flake jobs' tests: issues, their comments, and
 * which are sub-issues of which.
 */

interface FakeIssue extends TrackedIssue {
  readonly title: string;
  readonly labels: readonly string[];
  readonly body: string;
}

export class FakeTracker implements IssueTracker {
  issues: FakeIssue[] = [];
  readonly comments: { number: number; body: string }[] = [];
  readonly subIssues: { parent: number; child: number }[] = [];

  findByTitle(title: string, label: string): Promise<TrackedIssue | undefined> {
    const matches = this.issues.filter((i) => i.title === title && i.labels.includes(label));
    return Promise.resolve(matches.find((i) => i.open) ?? matches[0]);
  }

  create(issue: { title: string; body: string; labels: readonly string[] }): Promise<TrackedIssue> {
    const number = 900 + this.issues.length;
    const created = { ...issue, number, id: number * 1000, open: true };
    this.issues.push(created);
    return Promise.resolve(created);
  }

  comment(number: number, body: string): Promise<void> {
    this.comments.push({ number, body });
    return Promise.resolve();
  }

  reopen(number: number): Promise<void> {
    this.issues = this.issues.map((i) => (i.number === number ? { ...i, open: true } : i));
    return Promise.resolve();
  }

  addSubIssue(parent: number, child: TrackedIssue): Promise<void> {
    this.subIssues.push({ parent, child: child.id });
    return Promise.resolve();
  }

  isOpen(number: number): Promise<boolean | undefined> {
    return Promise.resolve(this.issues.find((i) => i.number === number)?.open);
  }
}
