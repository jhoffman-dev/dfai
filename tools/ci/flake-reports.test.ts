import { describe, expect, it } from 'vitest';
import type { FlakeRecord } from './e2e-flakes.ts';
import {
  HUNT_TITLE,
  flakyIssueReport,
  flakyIssueTitle,
  flakySummary,
  huntIssueReport,
} from './flake-reports.ts';

const RUN = {
  url: 'https://github.com/o/r/actions/runs/7/attempts/1',
  context: 'pull request #812',
};

function record(overrides: Partial<FlakeRecord> = {}): FlakeRecord {
  return {
    file: 'e2e/board.spec.ts',
    title: 'board › moves a card',
    project: 'webkit',
    tries: 2,
    failures: 1,
    passed: true,
    errorLines: ['Error: expect(locator).toBeVisible() failed', '  at e2e/board.spec.ts:40:5'],
    ...overrides,
  };
}

describe("a flaky test's issue", () => {
  it('is titled by file and test, so its next flake finds it', () => {
    expect(flakyIssueTitle(record())).toBe('Flaky e2e: e2e/board.spec.ts › board › moves a card');
  });

  it('keeps a long title inside what GitHub takes', () => {
    const title = flakyIssueTitle(record({ title: 'x'.repeat(400) }));
    expect(title.length).toBeLessThanOrEqual(256);
    expect(title.endsWith('…')).toBe(true);
  });

  it('links the run, the report, and quotes the failure lines', () => {
    const { body, comment } = flakyIssueReport(
      record({ reportUrl: 'https://github.com/o/r/actions/runs/7/artifacts/3' }),
      RUN,
    );
    for (const text of [body, comment]) {
      expect(text).toContain(`[this run](${RUN.url}) on pull request #812`);
      expect(text).toContain('Report and trace: https://github.com/o/r/actions/runs/7/artifacts/3');
      expect(text).toContain('````text\nError: expect(locator).toBeVisible() failed\n');
    }
    expect(body).toContain('quarantined(<this issue>)');
  });

  it('says so when the failure left no message', () => {
    expect(flakyIssueReport(record({ errorLines: [] }), RUN).comment).toContain(
      '(no error message)',
    );
  });

  it('is cut to a length GitHub takes, however long the failure', () => {
    const { body } = flakyIssueReport(record({ errorLines: ['y'.repeat(70_000)] }), RUN);
    expect(body.length).toBeLessThan(65_536);
  });
});

describe("the flaky job's summary", () => {
  it('lists each flaky test with its report and issue', () => {
    const flaky = record({ reportUrl: 'https://example.test/report' });
    const summary = flakySummary(
      [flaky, record({ file: 'e2e/x.spec.ts', title: 'y' })],
      new Map([[flakyIssueTitle(flaky), { number: 901, action: 'opened' as const }]]),
    );
    expect(summary).toContain(
      '- `e2e/board.spec.ts` › board › moves a card [webkit] ([report](https://example.test/report)): #901 (opened)',
    );
    expect(summary).toContain('- `e2e/x.spec.ts` › y [webkit]: no issue filed');
  });

  it('says when no test needed its retry', () => {
    expect(flakySummary([], new Map())).toContain('None');
  });
});

describe("the nightly hunt's issue", () => {
  const records = [
    record({ file: 'e2e/table.spec.ts', title: 'sorts', tries: 3, failures: 1 }),
    record({ title: 'moves a card', tries: 3, failures: 2, passed: true }),
    record({ title: 'adds a card', tries: 3, failures: 3, passed: false }),
  ];

  it('is the one issue every night updates', () => {
    expect(huntIssueReport(records, RUN, 3).title).toBe(HUNT_TITLE);
  });

  it('lists every test that failed, grouped under its spec in file order', () => {
    const { body, comment } = huntIssueReport(records, RUN, 3);
    expect(comment).toContain('3 test(s) failed at least once in 3 runs');
    const board = comment.indexOf('#### `e2e/board.spec.ts`');
    const table = comment.indexOf('#### `e2e/table.spec.ts`');
    expect(board).toBeGreaterThan(-1);
    expect(table).toBeGreaterThan(board);
    expect(comment).toContain('- moves a card [webkit]: failed 2 of 3');
    expect(comment).toContain('- adds a card [webkit]: failed 3 of 3');
    expect(comment.indexOf('- sorts')).toBeGreaterThan(table);
    expect(body).toContain(comment);
  });
});
