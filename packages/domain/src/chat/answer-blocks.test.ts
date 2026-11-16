import { describe, expect, it } from 'vitest';
import { answerBlocks } from './answer-blocks.ts';

const shape = (answer: string) =>
  answerBlocks(answer).map((block) => `${block.kind}@${block.depth}:${block.text}`);

describe('answerBlocks, read as the editor draws the answer (#831)', () => {
  it('a fence at an outer item’s text, under an item nested in it, ends with the outer item', () => {
    // mdast: the fence closes the nested item and opens in the outer one, which `- w2` ends.
    expect(shape('- w0\n  - w1\n  ```\n- w2')).toEqual([
      'item@0:w0',
      'item@1:w1',
      'code@0:',
      'item@0:w2',
    ]);
    expect(shape('- w0\n  - w1\n  ```\n1. w2')).toEqual([
      'item@0:w0',
      'item@1:w1',
      'code@0:',
      'item@0:w2',
    ]);
  });

  it('a fence at an outer item’s text closed inside it leaves the outer item’s next item an item', () => {
    expect(shape('- w0\n  - w1\n  ```\n  w2\n  ```\n- w3')).toEqual([
      'item@0:w0',
      'item@1:w1',
      'code@0:w2',
      'item@0:w3',
    ]);
  });

  it('a setext underline outside a quote carries the quote’s paragraph on, and is no heading', () => {
    // CommonMark: a setext underline cannot be a lazy line, so `===` is paragraph text in the quote.
    expect(answerBlocks('> w0\n===\n> - w1')).toEqual([
      { kind: 'quote', text: 'w0\n===', marker: null, depth: 0, quoted: true },
      { kind: 'item', text: 'w1', marker: '-', depth: 0, quoted: true },
    ]);
  });

  it('a setext underline inside a quote still makes the quote’s line a heading', () => {
    expect(shape('> w0\n> ===\n> - w1')).toEqual(['heading@0:w0', 'item@0:w1']);
  });
});

/**
 * The work a read does, in lines visited by any reader: an answer is read
 * again on every streamed chunk, so it must stay in step with the answer's
 * own size — its lines and its `>` marks — at any quote depth (#845).
 */
describe('answerBlocks reads each line once per quote it is in', () => {
  const size = (answer: string) => answer.split('\n').length + (answer.match(/>/g) ?? []).length;
  const workOf = (answer: string) => {
    const work = { lines: 0 };
    answerBlocks(answer, work);
    return work.lines;
  };

  it('a lazy line under every one of 20 quotes, each one deeper', () => {
    const answer = Array.from({ length: 20 }, (_, at) => `${'> '.repeat(at + 1)}a\nb`).join('\n');
    expect(workOf(answer)).toBeGreaterThan(0);
    expect(workOf(answer)).toBeLessThanOrEqual(2 * size(answer));
  });

  it('one lazy line under 1,000 nested quotes', () => {
    const answer = `${'> '.repeat(1000)}a\nb`;
    expect(workOf(answer)).toBeGreaterThan(0);
    expect(workOf(answer)).toBeLessThanOrEqual(2 * size(answer));
  });

  it('4,000 lines alternating quoted and lazy', () => {
    const answer = Array.from({ length: 4000 }, (_, at) => (at % 2 ? 'b' : '> a')).join('\n');
    expect(workOf(answer)).toBeGreaterThan(0);
    expect(workOf(answer)).toBeLessThanOrEqual(2 * size(answer));
  });
});
