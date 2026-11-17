import { describe, expect, it } from 'vitest';
import type { EditorDocument, EditorNode } from '@dfai/domain';
import { parseMarkdownBody, serializeMarkdownBody } from './markdown-blocks.ts';
import { documentOf } from './writer-fuzz.test-support.ts';

/*
 * Attack on PR #893 (#888): shapes the 3000 seeds of the old property drew
 * and the listed documents do not. A listed line is always `piece(at)` then
 * `piece(at + 29)`, so no line starts with two pieces that make block markup
 * together — `#` then a space, `-` then a space, `1.` then a space or nothing
 * — and no listed list follows a paragraph inside a container with an empty
 * first item, and no listed task with an id holds only spaces. Each `it`
 * names the writer mutation the old seeds caught here and the new tests miss;
 * all pass against the writer as it is.
 */

const text = (value: string): EditorNode => ({ type: 'text', text: value });
const paragraph = (...content: EditorNode[]): EditorNode => ({ type: 'paragraph', content });
const note = (...content: EditorNode[]): EditorDocument => ({ type: 'doc', content });
const quote = (...content: EditorNode[]): EditorNode => ({ type: 'blockquote', content });
const callout = (...content: EditorNode[]): EditorNode => ({
  type: 'callout',
  attrs: { kind: 'note', title: null, fold: null },
  content,
});
const bullets = (...items: EditorNode[][]): EditorNode => ({
  type: 'bulletList',
  content: items.map((content) => ({ type: 'listItem', content })),
});

/** Every container a line of text can start in, holding `line`. */
const everywhere = (line: EditorNode): EditorDocument =>
  note(line, quote(line), callout(paragraph(text('k')), line), bullets([line]));

function readBack(doc: EditorDocument): { same: boolean; markdown: string } {
  const markdown = serializeMarkdownBody({ originalBody: '', parsed: parseMarkdownBody(''), doc });
  const reread = parseMarkdownBody(markdown).doc.content;
  return { same: documentOf(reread) === documentOf(doc.content), markdown };
}

function expectReadBack(doc: EditorDocument) {
  const { same, markdown } = readBack(doc);
  expect(same, markdown).toBe(true);
}

describe('a line whose first two pieces make block markup reads back as text', () => {
  // Mutation: the `\#` remark writes before a line-start `#` dropped.
  it.each(['# x', '#\tx', '## x'])('%j starting a line', (value) => {
    expectReadBack(everywhere(paragraph(text(value))));
  });

  // Mutation: the `\-` / `\+` remark writes before a line-start bullet dropped.
  it.each(['- x', '+ x', '-\tx', '+', '-'])('%j starting a line', (value) => {
    expectReadBack(everywhere(paragraph(text(value))));
  });

  // Mutation: the `\.` remark writes in a line-start `1.` dropped.
  it.each(['1.', '1. x', '3.\tx'])('%j starting a line', (value) => {
    expectReadBack(everywhere(paragraph(text(value))));
  });

  // Same three mutations: the line a hard break starts.
  it.each(['# x', '- x', '1. x', '1.'])('%j after a hard break', (value) => {
    expectReadBack(everywhere(paragraph(text('k'), { type: 'hardBreak' }, text(value))));
  });
});

describe('a list with an empty first item after a paragraph in a container', () => {
  // Mutation: `listAfterParagraph` (stringify-settings.ts) no longer puts a
  // blank line before a list whose first item is empty: `k\n-` underlines
  // `k` as a heading.
  const emptyFirst = bullets([paragraph()], [paragraph(text('x'))]);

  it('reads back in a list item', () => {
    expectReadBack(note(bullets([paragraph(text('k')), emptyFirst])));
  });

  it('reads back in a task item', () => {
    expectReadBack(
      note({
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: true },
            content: [paragraph(text('k')), emptyFirst],
          },
        ],
      }),
    );
  });

  // Not caught by that mutation (remark separates these itself); kept so the
  // shape is listed in every container.
  it('reads back in a quote and a callout', () => {
    expectReadBack(note(quote(paragraph(text('k')), emptyFirst)));
    expectReadBack(note(callout(paragraph(text('k')), emptyFirst)));
  });
});

describe('a task with an id whose line is only spaces', () => {
  // Mutations: `withAnchor` (editor-to-mdast.ts) counting spaces as words
  // (`trim()` dropped), or writing the spaces after the box bare rather than
  // as references: `- [ ]   ^id` reads back without its spaces.
  const task = (blank: string, more: EditorNode[] = []): EditorDocument =>
    note({
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [paragraph(text('k'))] },
        {
          type: 'taskItem',
          attrs: { checked: false, anchor: 'id5' },
          content: [paragraph(text(blank)), ...more],
        },
      ],
    });

  it.each([' ', '  ', '\t', '\u00a0', ' \u00a0 '])('%j reads back with its id', (blank) => {
    expectReadBack(task(blank));
  });

  it.each([' ', '  ', '\u00a0'])('%j reads back with its id, a quote after it', (blank) => {
    expectReadBack(task(blank, [quote(paragraph(text('x')))]));
  });
});
