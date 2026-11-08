import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLAKES_FILE,
  REPORT_URL_FILE,
  readShardFlakes,
  runLinkFromEnv,
  trackerFromEnv,
  writeSummary,
} from './flake-job-io.ts';
import { GitHubIssues } from './github-issues.ts';

const RECORD = {
  file: 'e2e/a.spec.ts',
  title: 'b',
  project: 'webkit',
  tries: 2,
  failures: 1,
  passed: true,
  errorLines: [],
};

describe("reading the shards' flake artifacts", () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'dfai-flake-io-'));
  });

  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  function shard(name: string, records: unknown, reportUrl?: string): void {
    mkdirSync(join(folder, name));
    writeFileSync(join(folder, name, FLAKES_FILE), JSON.stringify(records));
    if (reportUrl !== undefined)
      writeFileSync(join(folder, name, REPORT_URL_FILE), `${reportUrl}\n`);
  }

  it("gathers every shard's records in shard order, each with its shard's report link", () => {
    shard('e2e-flakes-10', [{ ...RECORD, title: 'ten' }]);
    shard('e2e-flakes-2', [RECORD], 'https://example.test/report-2');
    shard('e2e-flakes-3', []);
    expect(readShardFlakes(folder, 3)).toEqual([
      { ...RECORD, reportUrl: 'https://example.test/report-2' },
      { ...RECORD, title: 'ten' },
    ]);
  });

  it('throws when no shard handed any on, rather than reading it as no failures', () => {
    expect(() => readShardFlakes(join(folder, 'never-downloaded'), 8)).toThrow(/missing/);
  });

  it('throws, naming those there, when a shard is missing or left no file', () => {
    shard('e2e-flakes-1', []);
    mkdirSync(join(folder, 'e2e-flakes-2'));
    expect(() => readShardFlakes(folder, 3)).toThrow(
      '1 of 3 shards handed on their flakes (e2e-flakes-1)',
    );
  });

  it('throws on a record file that is not JSON, rather than reporting no flakes', () => {
    mkdirSync(join(folder, 'e2e-flakes-1'));
    writeFileSync(join(folder, 'e2e-flakes-1', FLAKES_FILE), '[{"file":');
    expect(() => readShardFlakes(folder)).toThrow(SyntaxError);
  });

  it("adds the summary to the job's page", () => {
    const summaryFile = join(folder, 'summary.md');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeSummary('### Flaky', { GITHUB_STEP_SUMMARY: summaryFile });
    writeSummary('none', {});
    expect(readFileSync(summaryFile, 'utf8')).toBe('### Flaky\n');
    vi.restoreAllMocks();
  });
});

describe("the workflow's environment", () => {
  const env = {
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'acme/notes',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_REF_NAME: '812/merge',
  };

  it("links the run's attempt, and names what it ran on", () => {
    expect(runLinkFromEnv({ ...env, RUN_CONTEXT: 'pull request #812' })).toEqual({
      url: 'https://github.com/acme/notes/actions/runs/42/attempts/2',
      context: 'pull request #812',
    });
    expect(runLinkFromEnv(env).context).toBe('812/merge');
  });

  it('gives a tracker only with a token', () => {
    expect(trackerFromEnv(env)).toBeUndefined();
    expect(trackerFromEnv({ ...env, GITHUB_TOKEN: '' })).toBeUndefined();
    expect(trackerFromEnv({ ...env, GITHUB_TOKEN: 't' })).toBeInstanceOf(GitHubIssues);
  });
});
