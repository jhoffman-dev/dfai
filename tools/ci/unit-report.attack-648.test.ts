import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestSpecification, Vitest } from 'vitest/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DurationSequencer } from './duration-sequencer.ts';

/*
 * Attack on PR #648: ways the `coverage` job's "every test file ran on a
 * shard" check (unit-report.mjs) and the duration sequencer could let a run
 * pass with a test that did not run. Each gap found is
 * closed, and held closed here.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(import.meta.dirname, 'unit-report.mjs');
const FILE_A = `${ROOT}tools/ci/a.test.ts`;
const FILE_B = `${ROOT}tools/ci/b.test.ts`;

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'unit-report-attack-648-'));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

interface Reported {
  readonly name: string;
  readonly assertionResults: readonly { readonly status: string }[];
}

function unitReport(listed: readonly object[], testResults: readonly Reported[]) {
  const report = join(folder, 'report.json');
  const list = join(folder, 'list.json');
  writeFileSync(
    report,
    JSON.stringify({
      testResults: testResults.map((file) => ({ ...file, startTime: 0, endTime: 2000 })),
    }),
  );
  writeFileSync(list, JSON.stringify(listed));
  return spawnSync('node', [SCRIPT, report, list, join(folder, 'durations.json')], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

const passed = (name: string): Reported => ({ name, assertionResults: [{ status: 'passed' }] });

describe('the check that every test file ran on a shard', () => {
  it('passes when every listed file has a result', () => {
    expect(unitReport([{ file: FILE_A }], [passed(FILE_A)]).status).toBe(0);
  });

  it('refuses an empty list of test files rather than passing on none', () => {
    // A `vitest list` run from the wrong folder, or with a filter, lists nothing: 0 of 0 "ran".
    expect(unitReport([], [passed(FILE_A)]).status).not.toBe(0);
  });

  it('does not count a file whose every test was skipped as run', () => {
    // A `testNamePattern`, `describe.skip` or a shard filter leaves the file in the report, no test run.
    const skipped: Reported = {
      name: FILE_B,
      assertionResults: [{ status: 'skipped' }, { status: 'skipped' }],
    };
    expect(
      unitReport([{ file: FILE_A }, { file: FILE_B }], [passed(FILE_A), skipped]).status,
    ).not.toBe(0);
  });

  it('counts a file listed under two projects as run only when both ran it', () => {
    // `vitest list` lists a file once per project; the check matches by path alone.
    const listed = [
      { file: FILE_A, projectName: 'node' },
      { file: FILE_A, projectName: 'jsdom' },
    ];
    expect(unitReport(listed, [passed(FILE_A)]).status).not.toBe(0);
  });
});

/** A spec as the sequencer sees one: its file, and the project it runs in. */
const spec = (file: string, project: string) =>
  ({ moduleId: file, project: { name: project } }) as unknown as TestSpecification;

function sequencerFor(index: number, count: number): DurationSequencer {
  const ctx = { config: { root: ROOT, shard: { index, count } } } as unknown as Vitest;
  return new DurationSequencer(ctx);
}

describe('the duration sequencer over the shards', () => {
  it('deals every file to exactly one shard', async () => {
    const specs = [spec(FILE_A, 'node'), spec(FILE_B, 'node')];
    const dealt = await Promise.all([1, 2, 3].map((index) => sequencerFor(index, 3).shard(specs)));
    expect(dealt.flat()).toHaveLength(2);
  });

  it('runs a file that is in two projects in both of them', async () => {
    // Keyed by path, the second project's spec of a file is dropped on every shard.
    const specs = [spec(FILE_A, 'node'), spec(FILE_A, 'jsdom'), spec(FILE_B, 'node')];
    const dealt = await Promise.all([1, 2].map((index) => sequencerFor(index, 2).shard(specs)));
    expect(dealt.flat()).toHaveLength(3);
  });
});
