import { describe, expect, it } from 'vitest';
import { FLAKE_EPIC, FLAKY_LABEL, fileOrUpdate } from './flake-issues.ts';
import { FakeTracker } from './flake-issues.test-support.ts';

const REPORT = {
  title: 'Flaky e2e: e2e/board.spec.ts › moves a card',
  body: 'first seen',
  comment: 'seen again',
};

describe('filing a flaky test', () => {
  it('opens an issue labelled flaky, under the reliability epic, the first time', async () => {
    const tracker = new FakeTracker();
    const filed = await fileOrUpdate(tracker, REPORT);
    expect(filed).toEqual({ number: 900, action: 'opened' });
    expect(tracker.issues[0]).toMatchObject({ title: REPORT.title, body: 'first seen' });
    expect(tracker.issues[0]!.labels).toEqual([FLAKY_LABEL]);
    expect(tracker.subIssues).toEqual([{ parent: FLAKE_EPIC, child: 900_000 }]);
  });

  it('comments on the open issue when the test flakes again, opening no second one', async () => {
    const tracker = new FakeTracker();
    await fileOrUpdate(tracker, REPORT);
    const again = await fileOrUpdate(tracker, REPORT);
    expect(again).toEqual({ number: 900, action: 'commented' });
    expect(tracker.issues).toHaveLength(1);
    expect(tracker.comments).toEqual([{ number: 900, body: 'seen again' }]);
    expect(tracker.subIssues).toHaveLength(1);
  });

  it('reopens an issue closed as fixed when its test flakes again', async () => {
    const tracker = new FakeTracker();
    await fileOrUpdate(tracker, REPORT);
    tracker.issues = tracker.issues.map((i) => ({ ...i, open: false }));
    const again = await fileOrUpdate(tracker, REPORT);
    expect(again).toEqual({ number: 900, action: 'reopened' });
    expect(await tracker.isOpen(900)).toBe(true);
    expect(tracker.comments).toEqual([{ number: 900, body: 'seen again' }]);
  });

  it('keeps one issue per test: another title opens its own', async () => {
    const tracker = new FakeTracker();
    await fileOrUpdate(tracker, REPORT);
    const other = await fileOrUpdate(tracker, { ...REPORT, title: 'Flaky e2e: e2e/x.spec.ts › y' });
    expect(other).toEqual({ number: 901, action: 'opened' });
  });

  it('passes on a failure to file, so the job says it could not', async () => {
    const tracker = new FakeTracker();
    tracker.create = () => Promise.reject(new Error('GitHub POST /issues: 403'));
    await expect(fileOrUpdate(tracker, REPORT)).rejects.toThrow('403');
  });
});
