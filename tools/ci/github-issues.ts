import type { IssueFacts, IssueTracker, TrackedIssue } from './flake-issues.ts';

/*
 * The `IssueTracker` port over GitHub's REST API, with the workflow's
 * `GITHUB_TOKEN` (#799). It translates; flake-issues.ts decides what to file.
 */

export interface GitHubConnection {
  /** `GITHUB_API_URL`: https://api.github.com, or a stand-in's in a test. */
  readonly apiUrl: string;
  /** `owner/name`, as `GITHUB_REPOSITORY` gives it. */
  readonly repository: string;
  readonly token: string;
  readonly timeoutMs?: number;
}

interface IssueJson {
  readonly number: number;
  readonly id: number;
  readonly title: string;
  readonly state: string;
  readonly pull_request?: unknown;
  readonly labels?: readonly (string | { readonly name?: string })[];
}

const PAGE = 100;
/** Pages of `flaky` issues to look through: far more than there should ever be. */
const MOST_PAGES = 20;

const tracked = (issue: IssueJson): TrackedIssue => ({
  number: issue.number,
  id: issue.id,
  open: issue.state === 'open',
});

export class GitHubIssues implements IssueTracker {
  private readonly connection: GitHubConnection;

  // A field, not a parameter property: `node` runs this file by stripping types.
  constructor(connection: GitHubConnection) {
    this.connection = connection;
  }

  async findByTitle(title: string, label: string): Promise<TrackedIssue | undefined> {
    const matches: IssueJson[] = [];
    for (let page = 1; page <= MOST_PAGES; page += 1) {
      const query = `labels=${encodeURIComponent(label)}&state=all&per_page=${PAGE}&page=${page}`;
      const issues = await this.request<IssueJson[]>('GET', `/issues?${query}`);
      matches.push(...issues.filter((i) => i.pull_request === undefined && i.title === title));
      if (issues.length < PAGE) break;
    }
    const match = matches.find((i) => i.state === 'open') ?? matches[0];
    return match === undefined ? undefined : tracked(match);
  }

  async create(issue: {
    readonly title: string;
    readonly body: string;
    readonly labels: readonly string[];
  }): Promise<TrackedIssue> {
    return tracked(await this.request<IssueJson>('POST', '/issues', { body: issue }));
  }

  async comment(issueNumber: number, body: string): Promise<void> {
    await this.request('POST', `/issues/${issueNumber}/comments`, { body: { body } });
  }

  async reopen(issueNumber: number): Promise<void> {
    await this.request('PATCH', `/issues/${issueNumber}`, { body: { state: 'open' } });
  }

  async addSubIssue(parentNumber: number, child: TrackedIssue): Promise<void> {
    if (await this.isSubIssue(parentNumber, child)) return;
    await this.request('POST', `/issues/${parentNumber}/sub_issues`, {
      body: { sub_issue_id: child.id },
    });
  }

  async findIssue(issueNumber: number): Promise<IssueFacts | undefined> {
    const issue = await this.request<IssueJson | undefined>('GET', `/issues/${issueNumber}`, {
      missingIsUndefined: true,
    });
    // GitHub answers GET /issues/{n} for a pull request too: that is no issue (PR #802's attack).
    if (issue === undefined || issue.pull_request !== undefined) return undefined;
    const labels = (issue.labels ?? []).map((label) =>
      typeof label === 'string' ? label : (label.name ?? ''),
    );
    return { open: issue.state === 'open', labels };
  }

  private async isSubIssue(parentNumber: number, child: TrackedIssue): Promise<boolean> {
    for (let page = 1; page <= MOST_PAGES; page += 1) {
      const query = `per_page=${PAGE}&page=${page}`;
      const subIssues = await this.request<IssueJson[]>(
        'GET',
        `/issues/${parentNumber}/sub_issues?${query}`,
      );
      if (subIssues.some((issue) => issue.id === child.id)) return true;
      if (subIssues.length < PAGE) return false;
    }
    return false;
  }

  /**
   * One call, under the repository. A status that is not 2xx throws, saying
   * which, except a 404 where `missingIsUndefined` asks for `undefined`.
   */
  private async request<T = unknown>(
    method: string,
    path: string,
    { body, missingIsUndefined = false }: { body?: object; missingIsUndefined?: boolean } = {},
  ): Promise<T> {
    const { apiUrl, repository, token, timeoutMs = 15_000 } = this.connection;
    const response = await fetch(`${apiUrl}/repos/${repository}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (missingIsUndefined && response.status === 404) return undefined as T;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
    }
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }
}
