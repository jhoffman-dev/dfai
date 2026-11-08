import { describe, expect, it } from 'vitest';
import { ERROR_LINES, errorLinesOf, flakeRecordsOf, isFlaky, type RanTest } from './e2e-flakes.ts';

const ESC = String.fromCharCode(27);

function ran(statuses: string[], overrides: Partial<RanTest> = {}): RanTest {
  return {
    file: 'e2e/board.spec.ts',
    title: 'board › moves a card',
    project: 'webkit',
    expectedStatus: 'passed',
    results: statuses.map((status, at) => ({
      status,
      errors:
        status === 'passed' ? [] : [{ message: `try ${at + 1} failed\n  at board.spec.ts:12` }],
    })),
    ...overrides,
  };
}

describe('the tests an e2e run failed on a try', () => {
  it('leave out a test that passed first time', () => {
    expect(flakeRecordsOf([ran(['passed'])])).toEqual([]);
  });

  it('call a test that failed and then passed its retry flaky', () => {
    const [record] = flakeRecordsOf([ran(['failed', 'passed'])]);
    expect(record).toMatchObject({ tries: 2, failures: 1, passed: true });
    expect(record!.errorLines).toEqual(['try 1 failed', '  at board.spec.ts:12']);
    expect(isFlaky(record!)).toBe(true);
  });

  it('keep a test that failed every try, which is not flaky but broken', () => {
    const [record] = flakeRecordsOf([ran(['failed', 'timedOut'])]);
    expect(record).toMatchObject({ tries: 2, failures: 2, passed: false });
    expect(isFlaky(record!)).toBe(false);
  });

  it("fold a test's repeats into one record, the first failure's lines kept", () => {
    const records = flakeRecordsOf([ran(['passed']), ran(['timedOut']), ran(['failed'])]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ tries: 3, failures: 2, passed: true });
    expect(records[0]!.errorLines[0]).toBe('try 1 failed');
  });

  it('keep the same title in another project or file apart', () => {
    const records = flakeRecordsOf([
      ran(['failed', 'passed']),
      ran(['failed', 'passed'], { project: 'ipad' }),
      ran(['failed', 'passed'], { file: 'e2e/other.spec.ts' }),
    ]);
    expect(records.map((record) => `${record.project} ${record.file}`)).toEqual([
      'webkit e2e/board.spec.ts',
      'ipad e2e/board.spec.ts',
      'webkit e2e/other.spec.ts',
    ]);
  });

  it('count a try stopped with the run, or skipped, as neither pass nor failure', () => {
    expect(flakeRecordsOf([ran(['interrupted']), ran(['skipped'])])).toEqual([]);
  });

  it('take a test expected to fail that failed as passing', () => {
    expect(flakeRecordsOf([ran(['failed'], { expectedStatus: 'failed' })])).toEqual([]);
  });
});

describe("a failed try's error lines", () => {
  it('drop the terminal colours and blank lines', () => {
    const message = `${ESC}[31mExpected: 3${ESC}[39m\n\n${ESC}[2mReceived: 2${ESC}[22m   `;
    expect(errorLinesOf([{ message }])).toEqual(['Expected: 3', 'Received: 2']);
  });

  it(`keep the first ${ERROR_LINES} lines of all the errors`, () => {
    const message = Array.from({ length: 30 }, (_, at) => `line ${at}`).join('\n');
    const lines = errorLinesOf([{ message }, { message: 'second error' }]);
    expect(lines).toHaveLength(ERROR_LINES);
    expect(lines[0]).toBe('line 0');
  });

  it('are none for an error with no message', () => {
    expect(errorLinesOf([{}])).toEqual([]);
  });
});
