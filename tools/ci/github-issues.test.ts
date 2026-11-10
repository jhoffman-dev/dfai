import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileOrUpdate } from './flake-issues.ts';
import { GitHubIssues } from './github-issues.ts';

/*
 * The adapter against a stand-in for GitHub's REST API on a local port: the
 * real requests, the real JSON, a server that keeps issues and answers as
 * GitHub does, including the ways it fails.
 */

interface StoredIssue {
  number: number;
  id: number;
  title: string;
  state: string;
  labels: { name: string }[];
  pull_request?: object;
}

interface Call {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

const REPO = 'acme/notes';

class StandInGitHub {
  issues: StoredIssue[] = [];
  /** The ids under each parent issue's number. */
  readonly subIssues = new Map<number, number[]>();
  readonly calls: Call[] = [];
  /** Answers every call with this status instead, when set. */
  failWith: { status: number; text: string } | undefined;
  /** Never answers, when set. */
  hang = false;
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((request, response) => void this.answer(request, response));
    await new Promise<void>((done) => this.server!.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((done) => this.server?.close(done));
  }

  private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const url = new URL(request.url!, 'http://stand-in');
    this.calls.push({
      method: request.method!,
      path: url.pathname + url.search,
      authorization: request.headers.authorization,
      body: text === '' ? undefined : JSON.parse(text),
    });
    if (this.hang) return;
    if (this.failWith !== undefined) {
      response.writeHead(this.failWith.status).end(this.failWith.text);
      return;
    }
    const [status, json] = this.route(request.method!, url, text === '' ? {} : JSON.parse(text));
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
  }

  private route(method: string, url: URL, body: Record<string, unknown>): [number, unknown] {
    const base = `/repos/${REPO}/issues`;
    const one = new RegExp(`^${base}/(\\d+)$`).exec(url.pathname);
    if (method === 'GET' && url.pathname === base) return [200, this.page(url.searchParams)];
    if (method === 'POST' && url.pathname === base) return [201, this.create(body)];
    if (one !== null) {
      const issue = this.issues.find((i) => i.number === Number(one[1]));
      if (issue === undefined) return [404, { message: 'Not Found' }];
      if (method === 'PATCH') issue.state = String(body.state);
      return [200, issue];
    }
    const sub = new RegExp(`^${base}/(\\d+)/sub_issues$`).exec(url.pathname);
    if (sub !== null) return this.subIssue(method, Number(sub[1]), body);
    if (url.pathname.endsWith('/comments')) return [201, { id: 1 }];
    return [404, { message: 'Not Found' }];
  }

  /** GitHub refuses a second link to the same parent with a 422. */
  private subIssue(
    method: string,
    parent: number,
    body: Record<string, unknown>,
  ): [number, unknown] {
    const ids = this.subIssues.get(parent) ?? [];
    if (method === 'GET') return [200, ids.map((id) => ({ id }))];
    if (ids.includes(Number(body.sub_issue_id))) return [422, { message: 'already a sub-issue' }];
    this.subIssues.set(parent, [...ids, Number(body.sub_issue_id)]);
    return [201, { id: body.sub_issue_id }];
  }

  private page(params: URLSearchParams): StoredIssue[] {
    const label = params.get('labels');
    const perPage = Number(params.get('per_page'));
    const page = Number(params.get('page'));
    return this.issues
      .filter((i) => i.labels.some((l) => l.name === label))
      .slice((page - 1) * perPage, page * perPage);
  }

  private create(body: Record<string, unknown>): StoredIssue {
    const number = 500 + this.issues.length;
    const labels = (body.labels as string[]).map((name) => ({ name }));
    const issue = { number, id: number * 7, title: String(body.title), state: 'open', labels };
    this.issues.push(issue);
    return issue;
  }
}

describe('the GitHub issues adapter', () => {
  let github: StandInGitHub;
  let issues: GitHubIssues;

  beforeEach(async () => {
    github = new StandInGitHub();
    const apiUrl = await github.start();
    issues = new GitHubIssues({ apiUrl, repository: REPO, token: 't0ken', timeoutMs: 1_000 });
  });

  afterEach(() => github.stop());

  it('opens an issue, finds it by title, and updates it rather than opening another', async () => {
    const report = { title: 'Flaky e2e: e2e/a.spec.ts › b', body: 'new', comment: 'again' };
    expect(await fileOrUpdate(issues, report)).toEqual({ number: 500, action: 'opened' });
    expect(await fileOrUpdate(issues, report)).toEqual({ number: 500, action: 'commented' });
    expect(github.issues).toHaveLength(1);
    const writes = github.calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', `/repos/${REPO}/issues`, { title: report.title, body: 'new', labels: ['flaky'] }],
      ['POST', `/repos/${REPO}/issues/126/sub_issues`, { sub_issue_id: 3500 }],
      ['POST', `/repos/${REPO}/issues/500/comments`, { body: 'again' }],
    ]);
    expect(github.calls.every((c) => c.authorization === 'Bearer t0ken')).toBe(true);
    expect(github.subIssues.get(126)).toEqual([3500]);
  });

  it('links an issue that is not under the epic yet, on a later flake', async () => {
    github.issues.push({
      number: 41,
      id: 4100,
      title: 'Flaky e2e: x',
      state: 'open',
      labels: [{ name: 'flaky' }],
    });
    const filed = await fileOrUpdate(issues, { title: 'Flaky e2e: x', body: '', comment: 'c' });
    expect(filed).toEqual({ number: 41, action: 'commented' });
    expect(github.subIssues.get(126)).toEqual([4100]);
  });

  it('reopens a closed issue for its title', async () => {
    github.issues.push({
      number: 41,
      id: 4100,
      title: 'Flaky e2e: x',
      state: 'closed',
      labels: [{ name: 'flaky' }],
    });
    const filed = await fileOrUpdate(issues, { title: 'Flaky e2e: x', body: '', comment: 'c' });
    expect(filed).toEqual({ number: 41, action: 'reopened' });
    expect(github.issues[0]!.state).toBe('open');
  });

  it('looks past the first page, and past pull requests with the same title', async () => {
    for (let at = 0; at < 130; at += 1) {
      const title = at === 0 ? 'wanted' : at === 120 ? 'wanted' : `other ${at}`;
      const pullRequest = at === 0 ? { pull_request: {} } : {};
      github.issues.push({
        number: at + 1,
        id: at + 1,
        title,
        state: 'open',
        labels: [{ name: 'flaky' }],
        ...pullRequest,
      });
    }
    expect(await issues.findByTitle('wanted', 'flaky')).toEqual({
      number: 121,
      id: 121,
      open: true,
    });
    expect(await issues.findByTitle('missing', 'flaky')).toBeUndefined();
  });

  it('says whether an issue is open, and when there is none', async () => {
    github.issues.push({ number: 7, id: 70, title: 'x', state: 'open', labels: [] });
    github.issues.push({ number: 8, id: 80, title: 'y', state: 'closed', labels: [] });
    expect((await issues.findIssue(7))?.open).toBe(true);
    expect((await issues.findIssue(8))?.open).toBe(false);
    expect(await issues.findIssue(9)).toBeUndefined();
  });

  it("reads an issue's labels, and takes a pull request for no issue", async () => {
    github.issues.push({
      number: 7,
      id: 70,
      title: 'x',
      state: 'open',
      labels: [{ name: 'flaky' }],
    });
    github.issues.push({
      number: 8,
      id: 80,
      title: 'y',
      state: 'open',
      labels: [],
      pull_request: {},
    });
    expect(await issues.findIssue(7)).toEqual({ open: true, labels: ['flaky'] });
    expect(await issues.findIssue(8)).toBeUndefined();
  });

  it('throws with the status when GitHub refuses, as a token without issues: write is', async () => {
    github.failWith = { status: 403, text: '{"message":"Resource not accessible by integration"}' };
    await expect(issues.comment(1, 'x')).rejects.toThrow(
      /GitHub POST \/issues\/1\/comments: 403 .*not accessible/,
    );
    await expect(issues.findIssue(1)).rejects.toThrow('403');
  });

  it('throws on an answer that is not JSON', async () => {
    github.failWith = { status: 200, text: '<html>unicorn</html>' };
    await expect(issues.findByTitle('x', 'flaky')).rejects.toThrow(SyntaxError);
  });

  it('gives up on a GitHub that does not answer', async () => {
    github.hang = true;
    await expect(issues.findIssue(1)).rejects.toThrow(/timeout|aborted/i);
  });
});
