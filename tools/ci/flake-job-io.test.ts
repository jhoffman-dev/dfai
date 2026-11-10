import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLAKES_FILE,
  REPORT_URL_FILE,
  SHARD_FILE,
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

  /** One shard's artifact, as the flake reporter leaves it: shard `current` of `total`. */
  function shard(
    { current, total }: { current: number; total: number },
    records: unknown,
    reportUrl?: string,
  ): void {
    const dir = join(folder, `e2e-flakes-${current}`);
    mkdirSync(dir);
    writeFileSync(join(dir, FLAKES_FILE), JSON.stringify(records));
    writeFileSync(join(dir, SHARD_FILE), JSON.stringify({ current, total }));
    if (reportUrl !== undefined) writeFileSync(join(dir, REPORT_URL_FILE), `${reportUrl}\n`);
  }

  it("gathers every shard's records in shard order, each with its shard's report link", () => {
    shard({ current: 10, total: 10 }, [{ ...RECORD, title: 'ten' }]);
    shard({ current: 2, total: 10 }, [RECORD], 'https://example.test/report-2');
    for (const current of [1, 3, 4, 5, 6, 7, 8, 9]) shard({ current, total: 10 }, []);
    expect(readShardFlakes(folder)).toEqual([
      { ...RECORD, reportUrl: 'https://example.test/report-2' },
      { ...RECORD, title: 'ten' },
    ]);
  });

  it('throws when no shard handed any on, rather than reading it as no failures', () => {
    expect(() => readShardFlakes(join(folder, 'never-downloaded'))).toThrow(/missing/);
    expect(() => readShardFlakes(folder)).toThrow(/no shard's flakes/);
  });

  it('throws, naming it, when a shard of the run is missing', () => {
    shard({ current: 1, total: 3 }, []);
    shard({ current: 3, total: 3 }, []);
    expect(() => readShardFlakes(folder)).toThrow(
      '2 of 3 shards handed on their flakes; missing: 2',
    );
  });

  it('throws when the matrix grew and its new shard died: the others count it', () => {
    for (let current = 1; current <= 8; current += 1) shard({ current, total: 9 }, []);
    expect(() => readShardFlakes(folder)).toThrow(
      '8 of 9 shards handed on their flakes; missing: 9',
    );
  });

  it('throws when the shards disagree on how many there were, or one does not say', () => {
    shard({ current: 1, total: 2 }, []);
    shard({ current: 2, total: 3 }, []);
    expect(() => readShardFlakes(folder)).toThrow('disagree');
    rmSync(join(folder, 'e2e-flakes-2', SHARD_FILE));
    expect(() => readShardFlakes(folder)).toThrow(`no ${SHARD_FILE}`);
  });

  it('throws on a record file that is not JSON, rather than reporting no flakes', () => {
    shard({ current: 1, total: 1 }, []);
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
