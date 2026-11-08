import { describe, expect, it } from 'vitest';
import { quarantined } from '../../e2e/quarantine.ts';
import {
  issueOf,
  outcomeWord,
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
  const states = new Map<number, boolean | undefined>([
    [812, true],
    [700, false],
  ]);

  it('is in order when each test names an open issue', () => {
    expect(quarantineProblems([test(), test({ title: 'other' })], states)).toEqual([]);
  });

  it('has a problem for a test that names no issue, a closed one, or one that does not exist', () => {
    const problems = quarantineProblems(
      [test({ issue: undefined }), test({ issue: 700 }), test({ issue: 999 })],
      states,
    );
    expect(problems).toEqual([
      'e2e/board.spec.ts › moves a card names no issue: quarantine it with quarantined(<issue>)',
      'e2e/board.spec.ts › moves a card names #700, which is closed: fix the test or reopen it',
      'e2e/board.spec.ts › moves a card names #999, which does not exist',
    ]);
  });

  it("lists every quarantined test, its issue's state and how it did", () => {
    const summary = quarantineSummary(
      [test(), test({ title: 'sorts', issue: 700, outcome: 'failed' })],
      states,
    );
    expect(summary).toContain(
      '| `e2e/board.spec.ts` › moves a card | webkit | #812 (open) | passed |',
    );
    expect(summary).toContain('| `e2e/board.spec.ts` › sorts | webkit | #700 (closed) | failed |');
    expect(summary).toContain('**Problems**');
  });

  it('says when nothing is quarantined', () => {
    expect(quarantineSummary([], states)).toContain('None.');
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
