import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlakeRecord } from './e2e-flakes.ts';
import { readShardFlakes } from './flake-job-io.ts';
import { reportFlakyTests } from './flake-jobs.ts';
import { FLAKE_EPIC, type TrackedIssue } from './flake-issues.ts';
import { FakeTracker } from './flake-issues.test-support.ts';
import { flakyIssueReport, flakyIssueTitle, huntIssueReport } from './flake-reports.ts';
import { GitHubIssues } from './github-issues.ts';

/*
 * Adversarial probes of PR #802 (#799): the changed-spec picker as the gate
 * pipes git into it, the flake jobs' inputs and issue filing, and the
 * quarantine's issue check. Each test states an invariant the PR means to
 * hold and fails where it does not.
 */

const SCOPE = resolve(import.meta.dirname, 'changed-scope.mjs');
const RUN = { url: 'https://github.com/o/r/actions/runs/9/attempts/1', context: 'main' };

const made: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfai-attack-802-'));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<FlakeRecord> = {}): FlakeRecord {
  return {
    file: 'e2e/board.spec.ts',
    title: 'moves a card',
    project: 'webkit',
    tries: 2,
    failures: 1,
    passed: true,
    errorLines: ['Timed out'],
    ...overrides,
  };
}

/** The `specs=` the gate's `changes` step writes, split as `read -ra` splits it. */
function specsFromScope(stdin: string, cwd: string): string[] {
  const out = execFileSync(process.execPath, [SCOPE], { input: stdin, cwd, encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('specs=')) ?? 'specs=';
  return line
    .slice('specs='.length)
    .split(/\s+/)
    .filter((s) => s !== '');
}

/** Body text outside fences and single-backtick code spans, where GitHub links `@name` and `#n`. */
function plainText(body: string): string {
  let fenced = false;
  return body
    .split('\n')
    .filter((line) => {
      if (/^`{3,}/.test(line)) fenced = !fenced;
      return !fenced && !/^`{3,}/.test(line);
    })
    .map((line) => line.replace(/`[^`]*`/g, ''))
    .join('\n');
}

describe('PR #802 attack: the changed specs the gate repeats', () => {
  it('lists a changed spec whose name is not ASCII, as `git diff --name-only` prints it on a runner', () => {
    const repo = tempDir();
    // A runner's git: no user or system config, so core.quotePath is its default.
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: repo,
        env,
        encoding: 'utf8',
      });
    git('init', '-q');
    mkdirSync(join(repo, 'e2e'));
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    writeFileSync(join(repo, 'e2e', 'café.spec.ts'), 'test\n');
    git('add', '.');
    git('commit', '-qm', 'spec');
    const diff = git('diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD');
    expect(specsFromScope(diff, repo)).toEqual(['e2e/café.spec.ts']);
  });

  it('hands a changed spec whose path has a space to e2e-new as one path, not two', () => {
    const repo = tempDir();
    mkdirSync(join(repo, 'e2e'));
    writeFileSync(join(repo, 'e2e', 'quick note.spec.ts'), 'test\n');
    expect(specsFromScope('e2e/quick note.spec.ts\n', repo)).toEqual(['e2e/quick note.spec.ts']);
  });
});

describe('PR #802 attack: the flake jobs read every shard', () => {
  it('fails loudly when no shard uploaded its flakes, rather than reading it as no failures', () => {
    // Every shard's reporter writes flakes.json, even an empty one: a missing
    // folder means the shards died before reporting, not that nothing failed.
    const missing = join(tempDir(), 'e2e-flakes');
    expect(() => readShardFlakes(missing)).toThrow();
  });
});

describe('PR #802 attack: filing flaky-test issues', () => {
  it('puts a flaky test issue under the epic even when the first link failed after it was opened', async () => {
    class LinkFailsOnce extends FakeTracker {
      private failed = false;
      override addSubIssue(parent: number, child: TrackedIssue): Promise<void> {
        if (!this.failed) {
          this.failed = true;
          return Promise.reject(new Error('GitHub POST /issues/126/sub_issues: 422'));
        }
        return super.addSubIssue(parent, child);
      }
    }
    const tracker = new LinkFailsOnce();
    await reportFlakyTests({ records: [record()], run: RUN, tracker });
    await reportFlakyTests({ records: [record()], run: RUN, tracker });
    expect(tracker.issues).toHaveLength(1);
    expect(tracker.subIssues).toContainEqual({ parent: FLAKE_EPIC, child: tracker.issues[0]!.id });
  });

  it('files two different long-titled tests as two issues, not one', () => {
    const shared = 'x'.repeat(300);
    expect(flakyIssueTitle(record({ title: `${shared} a` }))).not.toBe(
      flakyIssueTitle(record({ title: `${shared} b` })),
    );
  });

  it("keeps a test title's @mention and #ref out of the nightly hunt issue's linked text", () => {
    const title = 'pings @octocat and closes #12';
    const report = huntIssueReport([record({ title, passed: false })], RUN, 3);
    expect(plainText(report.body)).not.toMatch(/@octocat|#12\b/);
    expect(plainText(report.comment)).not.toMatch(/@octocat|#12\b/);
  });

  it("keeps a test title with a backtick from breaking out of the flaky issue's code span", () => {
    const report = flakyIssueReport(record({ title: 'x` @octocat' }), RUN);
    expect(plainText(report.body)).not.toMatch(/@octocat/);
  });
});

describe('PR #802 attack: the quarantine names an issue', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((done) => server?.close(done));
    server = undefined;
  });

  it('does not count an open pull request as the open issue a quarantined test names', async () => {
    // GitHub's GET /issues/{n} answers for pull requests too, with `pull_request` set.
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          number: 9,
          id: 90,
          title: 'feat: something',
          state: 'open',
          pull_request: { url: 'https://api.github.com/repos/acme/notes/pulls/9' },
        }),
      );
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const issues = new GitHubIssues({
      apiUrl,
      repository: 'acme/notes',
      token: 't',
      timeoutMs: 1_000,
    });
    expect(await issues.isOpen(9)).not.toBe(true);
  });
});
