import { describe, expect, it } from 'vitest';
import type { FlakeRecord } from './e2e-flakes.ts';
import { FakeTracker } from './flake-issues.test-support.ts';
import { reportFlakyTests, reportHunt, reportQuarantine } from './flake-jobs.ts';
import { HUNT_TITLE } from './flake-reports.ts';

const RUN = { url: 'https://github.com/o/r/actions/runs/9/attempts/1', context: 'main' };

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

describe("the gate's flaky job", () => {
  it('files an issue for each flaky test and goes red', async () => {
    const tracker = new FakeTracker();
    const result = await reportFlakyTests({
      records: [record(), record({ title: 'sorts' })],
      run: RUN,
      tracker,
    });
    expect(result.failed).toBe(true);
    expect(tracker.issues.map((i) => i.title)).toEqual([
      'Flaky e2e: e2e/board.spec.ts › moves a card',
      'Flaky e2e: e2e/board.spec.ts › sorts',
    ]);
    expect(result.summary).toContain('#900 (opened)');
    expect(result.summary).toContain('#901 (opened)');
  });

  it('leaves a test that failed both tries to the gate, which fails it', async () => {
    const tracker = new FakeTracker();
    const result = await reportFlakyTests({
      records: [record({ failures: 2, passed: false })],
      run: RUN,
      tracker,
    });
    expect(result.failed).toBe(false);
    expect(tracker.issues).toEqual([]);
  });

  it('is green when no test needed its retry', async () => {
    const result = await reportFlakyTests({ records: [], run: RUN, tracker: new FakeTracker() });
    expect(result).toMatchObject({ failed: false });
    expect(result.summary).toContain('None');
  });

  it('files nothing without a tracker, as on a fork, and still goes red', async () => {
    const result = await reportFlakyTests({ records: [record()], run: RUN });
    expect(result.failed).toBe(true);
    expect(result.summary).toContain('no issue filed');
  });

  it('files the rest when GitHub refuses one, and says which', async () => {
    const tracker = new FakeTracker();
    const create = tracker.create.bind(tracker);
    tracker.create = (issue) =>
      issue.title.endsWith('moves a card')
        ? Promise.reject(new Error('502 Bad Gateway'))
        : create(issue);
    const result = await reportFlakyTests({
      records: [record(), record({ title: 'sorts' })],
      run: RUN,
      tracker,
    });
    expect(tracker.issues.map((i) => i.title)).toEqual(['Flaky e2e: e2e/board.spec.ts › sorts']);
    expect(result.summary).toContain(
      '- could not file Flaky e2e: e2e/board.spec.ts › moves a card: 502 Bad Gateway',
    );
  });
});

describe('the nightly flake hunt', () => {
  it('files one issue for every test that failed a try, and updates it the next night', async () => {
    const tracker = new FakeTracker();
    const records = [
      record({ tries: 3 }),
      record({ title: 'sorts', tries: 3, failures: 3, passed: false }),
    ];
    const first = await reportHunt({ records, run: RUN, repeats: 3, tracker });
    const second = await reportHunt({ records, run: RUN, repeats: 3, tracker });
    expect(tracker.issues.map((i) => i.title)).toEqual([HUNT_TITLE]);
    expect(tracker.comments).toHaveLength(1);
    expect(first.summary).toContain('Filed in #900 (opened).');
    expect(second.summary).toContain('Filed in #900 (commented).');
    expect(second.summary).toContain('2 test(s) failed at least once in 3 runs');
  });

  it('files nothing on a night nothing failed', async () => {
    const tracker = new FakeTracker();
    const result = await reportHunt({ records: [], run: RUN, repeats: 3, tracker });
    expect(tracker.issues).toEqual([]);
    expect(result).toEqual({
      summary: '### Nightly e2e flake hunt\n\nNo test failed in 3 runs of the suite.\n',
      failed: false,
    });
  });

  it('passes on a failure to file, so the job goes red', async () => {
    const tracker = new FakeTracker();
    tracker.findByTitle = () => Promise.reject(new Error('403'));
    await expect(
      reportHunt({ records: [record()], run: RUN, repeats: 3, tracker }),
    ).rejects.toThrow('403');
  });
});

describe('the quarantine job', () => {
  const quarantinedTest = {
    file: 'e2e/board.spec.ts',
    title: 'moves a card',
    project: 'webkit',
    outcome: 'passed',
  };

  it('is green when every quarantined test names an open issue', async () => {
    const tracker = new FakeTracker();
    await tracker.create({ title: 'flaky board', body: '', labels: ['flaky'] });
    const result = await reportQuarantine({ tests: [{ ...quarantinedTest, issue: 900 }], tracker });
    expect(result.failed).toBe(false);
    expect(result.summary).toContain('#900 (open)');
  });

  it('goes red for a test whose issue is closed, missing, or not named', async () => {
    const tracker = new FakeTracker();
    await tracker.create({ title: 'flaky board', body: '', labels: ['flaky'] });
    tracker.issues = tracker.issues.map((i) => ({ ...i, open: false }));
    for (const issue of [900, 404, undefined]) {
      const tests = [issue === undefined ? quarantinedTest : { ...quarantinedTest, issue }];
      expect((await reportQuarantine({ tests, tracker })).failed).toBe(true);
    }
  });

  it('is green with nothing quarantined', async () => {
    expect(await reportQuarantine({ tests: [], tracker: new FakeTracker() })).toMatchObject({
      failed: false,
    });
  });
});
