import { describe, expect, it } from 'vitest';
import { quarantined } from '../../e2e/quarantine.ts';
import {
  issueOf,
  outcomeWord,
  quarantineOf,
  quarantineProblems,
  quarantineSummary,
  type QuarantinedTest,
} from './quarantine.ts';

function test(overrides: Partial<QuarantinedTest> = {}): QuarantinedTest {
  return {
    file: 'e2e/board.spec.ts',
    title: 'moves a card',
    project: 'webkit',
    issue: 812,
    outcome: 'passed',
    ...overrides,
  };
}

describe('the issue a quarantined test names', () => {
  it('is the one the quarantined() helper writes', () => {
    expect(quarantined(812).tag).toBe('@quarantine');
    expect(issueOf([quarantined(812).annotation])).toBe(812);
  });

  it('may be written as the issue link', () => {
    const description = 'https://github.com/acme/notes/issues/77 until the race is fixed';
    expect(issueOf([{ type: 'quarantine', description }])).toBe(77);
  });

  it('is read only from the quarantine annotation', () => {
    expect(issueOf([{ type: 'macOS only', description: '#5' }])).toBeUndefined();
    expect(issueOf([{ type: 'quarantine' }])).toBeUndefined();
    expect(issueOf([{ type: 'quarantine', description: 'flaky, see Slack' }])).toBeUndefined();
    expect(issueOf([])).toBeUndefined();
  });
});

describe('the quarantine', () => {
  const flaky = (open: boolean) => ({ open, labels: ['flaky'] });
  const states = new Map<number, { open: boolean; labels: string[] } | undefined>([
    [812, flaky(true)],
    [700, flaky(false)],
    [126, { open: true, labels: ['epic'] }],
  ]);

  it('is in order when each test names an open flaky issue', () => {
    expect(quarantineProblems([test(), test({ title: 'other' })], states)).toEqual([]);
  });

  it('has a problem for a test that names no issue, a closed one, no issue at all, or one not labelled flaky', () => {
    const problems = quarantineProblems(
      [
        test({ issue: undefined }),
        test({ issue: 700 }),
        test({ issue: 999 }),
        test({ issue: 126 }),
      ],
      states,
    );
    expect(problems).toEqual([
      'e2e/board.spec.ts › moves a card names no issue: quarantine it with quarantined(<issue>)',
      'e2e/board.spec.ts › moves a card names #700, which is closed: fix the test or reopen it',
      'e2e/board.spec.ts › moves a card names #999, which is no issue (missing, or a pull request)',
      "e2e/board.spec.ts › moves a card names #126, which is not labelled flaky: name the test's own flaky issue",
    ]);
  });

  it("lists every quarantined test, its issue's state and how it did, its title inert", () => {
    const summary = quarantineSummary(
      [
        test(),
        test({ title: 'sorts @octocat', issue: 700, outcome: 'failed' }),
        test({ title: 'epic', issue: 126 }),
      ],
      states,
    );
    expect(summary).toContain(
      '| e2e/board.spec.ts › moves a card | webkit | #812 (open) | passed |',
    );
    expect(summary).toContain('| #700 (closed) | failed |');
    expect(summary).toContain('| #126 (open, not flaky) |');
    expect(summary).not.toContain('@octocat');
    expect(summary).toContain('**Problems**');
  });

  it('says when nothing is quarantined', () => {
    expect(quarantineSummary([], states)).toContain('None.');
  });
});

describe("the quarantined tests, every platform's", () => {
  const listed = [
    test({ outcome: 'skipped' }),
    test({ title: 'transposes', outcome: 'skipped', macOnly: true }),
    test({ title: 'gone', outcome: 'skipped' }),
  ];

  it('take how each did where the Linux run ran it, and say where a macOS one runs', () => {
    const ran = [test({ outcome: 'flaky' })];
    expect(quarantineOf(listed, ran).map((t) => `${t.title}: ${t.outcome}`)).toEqual([
      'moves a card: flaky',
      'transposes: macOS only: runs in the macOS nightly',
      'gone: did not run',
    ]);
  });

  it('keep a test the Linux run could not run, so its issue is still checked', () => {
    const tests = quarantineOf(listed, []);
    expect(quarantineProblems(tests, new Map([[812, undefined]]))).toHaveLength(3);
  });
});

describe("a quarantined test's outcome", () => {
  it("is said in the summary's words", () => {
    expect(['expected', 'unexpected', 'flaky', 'skipped', 'odd'].map(outcomeWord)).toEqual([
      'passed',
      'failed',
      'flaky',
      'skipped',
      'odd',
    ]);
  });
});
