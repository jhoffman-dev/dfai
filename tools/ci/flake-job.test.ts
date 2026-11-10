import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countArgument, runFlakeJob } from './flake-job.ts';
import { FLAKES_FILE, SHARD_FILE } from './flake-job-io.ts';
import { FakeTracker } from './flake-issues.test-support.ts';

const FLAKY = {
  file: 'e2e/board.spec.ts',
  title: 'moves a card',
  project: 'webkit',
  tries: 2,
  failures: 1,
  passed: true,
  errorLines: ['Timed out'],
};
const ENV = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'acme/notes',
  GITHUB_RUN_ID: '1',
  GITHUB_REF_NAME: 'main',
};

describe('the flake jobs entry point', () => {
  let folder: string;
  let tracker: FakeTracker;
  const trackerFrom = () => tracker;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'dfai-flake-job-'));
    tracker = new FakeTracker();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(folder, { recursive: true, force: true });
  });

  function shards(...records: unknown[][]): string {
    const artifacts = join(folder, 'flakes');
    records.forEach((shard, at) => {
      mkdirSync(join(artifacts, `e2e-flakes-${at + 1}`), { recursive: true });
      writeFileSync(join(artifacts, `e2e-flakes-${at + 1}`, FLAKES_FILE), JSON.stringify(shard));
      writeFileSync(
        join(artifacts, `e2e-flakes-${at + 1}`, SHARD_FILE),
        JSON.stringify({ current: at + 1, total: records.length }),
      );
    });
    return artifacts;
  }

  it('files the flaky tests with FILE_ISSUES=true, and exits 1', async () => {
    const artifacts = shards([FLAKY], []);
    const env = { ...ENV, FILE_ISSUES: 'true' };
    expect(await runFlakeJob({ args: ['flaky', artifacts], env, trackerFrom })).toBe(1);
    expect(tracker.issues).toHaveLength(1);
  });

  it('files nothing without FILE_ISSUES=true, as on a fork, and still exits 1', async () => {
    const artifacts = shards([FLAKY]);
    expect(await runFlakeJob({ args: ['flaky', artifacts], env: ENV, trackerFrom })).toBe(1);
    expect(tracker.issues).toEqual([]);
  });

  it('exits 0 when no test needed its retry, and writes the summary to the job page', async () => {
    const summary = join(folder, 'summary.md');
    const env = { ...ENV, GITHUB_STEP_SUMMARY: summary };
    expect(await runFlakeJob({ args: ['flaky', shards([])], env, trackerFrom })).toBe(0);
    expect(readFileSync(summary, 'utf8')).toContain('None: no test needed its retry.');
  });

  it('fails when a shard did not hand its flakes on', async () => {
    const artifacts = shards([], [], []);
    rmSync(join(artifacts, 'e2e-flakes-2'), { recursive: true });
    await expect(
      runFlakeJob({ args: ['flaky', artifacts], env: ENV, trackerFrom }),
    ).rejects.toThrow('2 of 3 shards');
  });

  it('files the hunt and exits 0, and refuses repeats that are not a number', async () => {
    const env = { ...ENV, FILE_ISSUES: 'true' };
    const artifacts = shards([{ ...FLAKY, passed: false }]);
    expect(await runFlakeJob({ args: ['hunt', artifacts, '3'], env, trackerFrom })).toBe(0);
    expect(tracker.issues).toHaveLength(1);
    await expect(
      runFlakeJob({ args: ['hunt', artifacts, 'three'], env, trackerFrom }),
    ).rejects.toThrow('repeats must be a whole number of at least 1, not "three"');
  });

  it('checks the quarantine, red for a test whose issue is not an open flaky one', async () => {
    const listed = join(folder, 'listed.json');
    const ran = join(folder, 'ran.json');
    const test = { file: 'e2e/a.spec.ts', title: 'b', project: 'webkit', outcome: 'skipped' };
    writeFileSync(listed, JSON.stringify([{ ...test, issue: 900 }]));
    writeFileSync(ran, JSON.stringify([{ ...test, issue: 900, outcome: 'passed' }]));
    await tracker.create({ title: 'flaky a', body: '', labels: ['flaky'] });
    const args = ['quarantine', listed, ran];
    expect(await runFlakeJob({ args, env: ENV, trackerFrom })).toBe(0);
    tracker.issues = tracker.issues.map((issue) => ({ ...issue, labels: ['epic'] }));
    expect(await runFlakeJob({ args, env: ENV, trackerFrom })).toBe(1);
  });

  it('refuses the quarantine check without a token, and an unknown job', async () => {
    const none = () => undefined;
    await expect(
      runFlakeJob({ args: ['quarantine', 'a', 'b'], env: ENV, trackerFrom: none }),
    ).rejects.toThrow('GITHUB_TOKEN');
    await expect(runFlakeJob({ args: ['flakey'], env: ENV, trackerFrom })).rejects.toThrow(
      'unknown job "flakey"',
    );
  });
});

describe('a count argument', () => {
  it.each(['3', '12'])('takes %s', (value) => {
    expect(countArgument(value, 'shards')).toBe(Number(value));
  });

  it.each([undefined, '', '0', '-1', '2.5', '3x', 'NaN'])('refuses %s', (value) => {
    expect(() => countArgument(value, 'shards')).toThrow('shards must be a whole number');
  });
});
