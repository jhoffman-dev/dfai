import { describe, expect, it } from 'vitest';
import { answerBlocks } from './answer-blocks.ts';

/**
 * Attack on PR #845 (#831). Each answer below is one where the editor (mdast,
 * via the adapters' cross-check) draws the word as prose, yet Ask files it in
 * a block it exempts from the citation rule (code or heading). The verdict in
 * each comment is what `parseBodyToMdast` returns for that answer.
 */
const JUDGED = ['paragraph', 'item', 'quote', 'table'];

/** The kind of the block Ask puts `word` in, or `not drawn`. */
function askKindOf(answer: string, word: string): string {
  const block = answerBlocks(answer).find((each) => new RegExp(`\\b${word}\\b`).test(each.text));
  return block?.kind ?? 'not drawn';
}

describe('Ask judges what the editor draws as prose (attack on PR #845)', () => {
  it('a nested item’s own fence, then a fence at the outer item’s text, leaves the next outer item an item', () => {
    // mdast: list > [item w0 > [list > item w1 > code, code], item w2].
    expect(JUDGED).toContain(askKindOf('- w0\n  - w1\n    ```\n  ```\n- w2', 'w2'));
  });

  it('the same shape in an ordered list leaves `2.` an item', () => {
    // mdast: list > [item w0 > [list > item w1 > code, code], item w2].
    expect(JUDGED).toContain(askKindOf('1. w0\n   - w1\n     ```\n   ```\n2. w2', 'w2'));
  });

  it('the same shape followed by an unindented line leaves that line a paragraph', () => {
    // mdast: list (…), paragraph w2.
    expect(JUDGED).toContain(askKindOf('- w0\n  - w1\n    ```\n  ```\nw2', 'w2'));
  });

  it('a line after a quote ending in a thematic break is not lazy, so no setext heading', () => {
    // mdast: blockquote > [list > item w0, thematicBreak], paragraph w1, blockquote > paragraph `===`.
    expect(JUDGED).toContain(askKindOf('> - w0\n> ---\nw1\n> ===', 'w1'));
  });

  it('a fence in an item in a quote, closed by the quote’s own fence line, does not swallow the next line', () => {
    // mdast: blockquote > [list > item w0 > code, code], paragraph w1 (a quote's open fence takes no lazy line).
    expect(JUDGED).toContain(askKindOf('> - w0\n>   ```\n> ```\nw1', 'w1'));
  });

  // Still wrong, left for #849: a tab is counted as one column, where the editor expands it.
  it.fails('a tab-indented line past an item’s text is paragraph text, not a fence', () => {
    // mdast: list > item > [paragraph `w0\n```` , list > item w1]; two tabs are 8 columns, so not a fence.
    expect(JUDGED).toContain(askKindOf('- w0\n\t\t```\n  - w1', 'w1'));
  });

  // Still wrong, left for #849: an item marker after an indented code block is read as an item.
  it.fails(
    'a `10.` line after indented code is the editor’s paragraph, not an item that opens a fence',
    () => {
      // mdast: code ` - w0`, paragraph `10. w1\n```\nw2`.
      expect(JUDGED).toContain(askKindOf('     - w0\n10. w1\n     ```\n     w2', 'w2'));
    },
  );
});
