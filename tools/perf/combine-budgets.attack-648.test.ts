import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUDGETED_ACTIONS, RUN_TOLERANCE } from './budgeted-actions.ts';
import { combineParts, type PartResult, type Work } from './work-budgets.ts';

/*
 * Attack on PR #648: ways the `perf` job could pass with a budget's second
 * counted run, or the response-time budgets, not checked. Each `it.fails` is
 * a gap, failing on purpose until it is closed.
 */

const SCRIPT = join(import.meta.dirname, 'combine-budgets.ts');
const GATE = new URL('../../.github/workflows/gate.yml', import.meta.url);

const work = (commits: number): Work => ({ commits, renders: { Sidebar: 1 }, calls: {} });
const every = <Entry>(entry: Entry) =>
  Object.fromEntries(BUDGETED_ACTIONS.map((action) => [action, entry]));

/** Run 1 on one machine; run 2, counted 50 commits more on every action, on another; the timed pass on a third. */
const PARTS: Record<string, PartResult> = {
  'perf-0/perf/budgets.main.counted.json': { runs: [1], counted: every(work(4)), timed: {} },
  'perf-1/perf/budgets.main.counted.from-run-2.json': {
    runs: [2],
    counted: every(work(54)),
    timed: {},
  },
  'perf-2/perf/budgets.main.timed.json': {
    runs: [],
    counted: {},
    timed: every({ inputToReady: 10, longestFrame: 5 }),
  },
};

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'combine-attack-648-'));
  for (const [path, part] of Object.entries(PARTS)) {
    mkdirSync(join(folder, path, '..'), { recursive: true });
    writeFileSync(join(folder, path), JSON.stringify(part));
  }
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

function combine(env: Record<string, string>) {
  // The run's own settings are left out, so only what the test gives counts.
  const inherited = { ...process.env };
  delete inherited.PERF_BUDGETS_RUNS;
  delete inherited.GITHUB_STEP_SUMMARY;
  return spawnSync('node', [SCRIPT, folder], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...inherited, ...env },
  });
}

describe('putting the work budgets parts together, attacked', () => {
  it('fails a run 2 that counted differently, when told there are two runs', () => {
    expect(combine({ PERF_BUDGETS_RUNS: '2' }).status).toBe(1);
  });

  it.fails('fails a run 2 that counted differently even when PERF_BUDGETS_RUNS is unset', () => {
    // Unset, it takes one run and never looks at the part that counted run 2.
    expect(combine({}).status).not.toBe(0);
  });

  it.fails('flags a part that counted a run beyond the runs wanted', () => {
    const { problems } = combineParts(Object.values(PARTS), BUDGETED_ACTIONS, {
      runs: 1,
      tolerance: RUN_TOLERANCE,
    });
    expect(problems).not.toEqual([]);
  });
});

describe('the response-time budgets in the split perf jobs', () => {
  it.fails('are proven to have run by the perf job, as the work budgets are', () => {
    // Only the part with `latency: true` runs them; drop it and the gate stays green.
    const yaml = readFileSync(GATE, 'utf8');
    const perfJob = yaml.slice(yaml.indexOf('\n  perf:\n'), yaml.indexOf('\n  gate:\n'));
    const code = perfJob
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).toMatch(/latency/);
  });
});
