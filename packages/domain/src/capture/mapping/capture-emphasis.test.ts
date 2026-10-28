import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_LENGTH } from './capture-payload.ts';
import { pairEmphasis } from './capture-emphasis.ts';

const pairsOf = (line: string) => [...pairEmphasis(Array.from(line)).closes.entries()];

describe('pairEmphasis: Slack’s marks paired in one pass (review of PR #615)', () => {
  it.each([
    ['one mark', '*a*', [[0, 2]]],
    ['the first closer', '*a* b*', [[0, 2]]],
    [
      'two kinds nested',
      '*_a_*',
      [
        [1, 3],
        [0, 4],
      ],
    ],
    ['a mark inside a word', 'snake_case_name', []],
    ['a space after the opener', '* a*', []],
    ['a space before the closer', '*a *', []],
    ['a letter after the closer', '*a*b', []],
    ['a doubled mark', '**', []],
    ['a mark beyond U+FFFF before it', '\u{10000}*a*', []],
  ])('pairs %s', (_, line, pairs) => {
    expect(pairsOf(line)).toEqual(pairs);
  });

  it('sets aside the other marks opened inside a pair', () => {
    expect(pairsOf('*a _b*')).toEqual([[0, 5]]);
  });

  it.each([
    ['unclosed marks', '-*a'],
    ['openers of every kind, closed at the end', '*_~a '],
    ['openers and closers of other kinds', '*a_ ~b* '],
  ])('does work linear in a message of %s at Slack’s length', (_, unit) => {
    const line = Array.from(unit.repeat(Math.ceil(MAX_MESSAGE_LENGTH / unit.length)));
    expect(pairEmphasis(line).steps).toBeLessThanOrEqual(2 * line.length);
  });
});
