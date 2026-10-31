import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { budgetPartFiles, latencyFiles } from './part-files.ts';

/** What the `perf` job downloads: one folder per part's artifact (run 41174706890's, with its latency.json back). */
const DOWNLOADED = [
  'perf-0/perf/budgets.main.counted.json',
  'perf-1/perf/budgets.main.counted.from-run-2.json',
  'perf-2/perf/budgets.main.timed.json',
  'perf-3/perf/budgets.research+long-note+code-note.counted+timed.json',
  'perf-3/perf/latency.json',
  'perf-3/budgets/budgets-the-app-does-no-more-work-than-its-budget-budgets/error-context.md',
];

describe("finding the parts' results in the perf job's download", () => {
  it('finds every part of the work budgets, and only those', () => {
    expect(budgetPartFiles(DOWNLOADED)).toEqual(DOWNLOADED.slice(0, 4));
  });

  it("finds the response-time budgets' results", () => {
    expect(latencyFiles(DOWNLOADED)).toEqual(['perf-3/perf/latency.json']);
  });

  it('does not take the whole-run budgets.json, written only by an unsplit run', () => {
    expect(budgetPartFiles(['perf-0/perf/budgets.json'])).toEqual([]);
  });
});

describe("the perf job's parts keep each run's results", () => {
  const GATE = readFileSync(new URL('../../.github/workflows/gate.yml', import.meta.url), 'utf8');
  const part = GATE.slice(GATE.indexOf('\n  perf-part:\n'), GATE.indexOf('\n  perf:\n'));
  // Each `playwright test` command of a part, folded onto one line.
  const runs = part
    .replace(/>\n\s+/g, '')
    .replace(/\n\s{10,}(?=\S)/g, ' ')
    .split('\n')
    .filter((line) => line.includes('playwright test'));

  it('runs the response times, then the work budgets', () => {
    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain('--project latency');
    expect(runs[1]).toContain('--project budgets');
  });

  it('gives the later run an output folder of its own, so it does not empty the latency results', () => {
    // Playwright empties its output folder as it starts: test-results by default, where latency.json is written.
    expect(runs[0]).not.toContain('--output');
    expect(runs[1]).toMatch(/--output test-results\/\S+/);
    expect(runs[1]).not.toMatch(/--output test-results\/?(\s|$)/);
  });

  it('uploads the folder both write their results into', () => {
    expect(part).toContain('test-results/perf/');
  });
});
