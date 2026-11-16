import { describe, expect, it } from 'vitest';
import { answerBlocks } from './answer-blocks.ts';

/**
 * Second attack on PR #845 (#831): a differential fuzz of origin/main's reader,
 * the line-at-a-time rewrite, and the editor's (mdast, via the adapters'
 * cross-check). Each answer below is one the rewrite reads differently from
 * the editor where main read it as the editor does. The verdict in each
 * comment is what `parseBodyToMdast` returns for that answer.
 */
const JUDGED = ['paragraph', 'item', 'quote', 'table'];

/** The kind of the block Ask puts `word` in, or `not drawn`. */
function askKindOf(answer: string, word: string): string {
  const block = answerBlocks(answer).find((each) => new RegExp(`\\b${word}\\b`).test(each.text));
  return block?.kind ?? 'not drawn';
}

describe('Ask reads as the editor does where main did (second attack on PR #845)', () => {
  it('a line under a quoted `|` row with no delimiter row is the quote’s lazy text, not a setext heading', () => {
    // mdast: blockquote > paragraph "| w0 |\nw1\n===" (one row is no table, so its paragraph takes lazy lines).
    expect(JUDGED).toContain(askKindOf('> | w0 |\nw1\n===', 'w1'));
  });

  it('the same line over `---` is the quote’s lazy text, and the `---` a rule', () => {
    // mdast: blockquote > paragraph "| w0 |\nw1", thematicBreak.
    expect(JUDGED).toContain(askKindOf('> | w0 |\nw1\n---', 'w1'));
  });

  it('an indented fence line in a quote where the editor reads `-` as text stays the paragraph’s text', () => {
    // mdast: paragraph w9, blockquote > paragraph "-\n3) w0\n~~~~ py\n### w1 ##"
    // (the editor does not start a list at `> -` under a paragraph; main kept w1 in an item).
    expect(JUDGED).toContain(askKindOf('w9\n> -\n>   3) w0\n>     ~~~~ py\n>     ### w1 ##', 'w1'));
  });

  it('a fence in a quote after an empty quoted item and an unquoted line is code, as main read it', () => {
    // mdast: blockquote > list > item(empty), paragraph w0, blockquote > code "w1".
    expect(askKindOf('> -\nw0\n> ```\n> w1', 'w1')).toBe('code');
  });
});

describe('Ask survives a deep quote (second attack on PR #845)', () => {
  it('reads 5,000 nested quotes followed by a lazy line without overflowing the stack', () => {
    // Head throws RangeError here (main already threw at 3,000); a throw fails the whole answer's render.
    const answer = `${'>'.repeat(5000)} w0\nw1`;
    expect(() => answerBlocks(answer)).not.toThrow();
  });

  it('reads 10,000 nested quotes on one line without overflowing the stack', () => {
    expect(() => answerBlocks(`${'>'.repeat(10000)} w0`)).not.toThrow();
  });
});
