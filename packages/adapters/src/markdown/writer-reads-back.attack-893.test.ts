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

describe('a line starting with `_` before italic written with `_` reads back as text', () => {
  // Second pass: the `\_` remark writes before a line-start `_` dropped
  // (old seed 2413). Italic beside bold is written `_…_`, and a bare `_`
  // starting the line then opens emphasis with it. Listed lines put a piece
  // at a line start, or a mark first, never both.
  const bold = (value: string): EditorNode => ({ ...text(value), marks: [{ type: 'bold' }] });
  const italicStrike = (value: string): EditorNode => ({
    ...text(value),
    marks: [{ type: 'italic' }, { type: 'strike' }],
  });
  const line = [text('_~'), bold('x'), italicStrike('y')];
  const inEach = (content: EditorNode[]): EditorDocument =>
    note(
      paragraph(...content),
      { type: 'heading', attrs: { level: 2 }, content },
      quote(paragraph(...content)),
      callout(paragraph(text('k')), paragraph(...content)),
      bullets([paragraph(...content)]),
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: false }, content: [paragraph(...content)] },
        ],
      },
      paragraph(text('k'), { type: 'hardBreak' }, ...content),
    );

  it('in every kind of text block', () => {
    expectReadBack(inEach(line));
  });
});

describe('an id on a block whose only content is a hard break', () => {
  // Second pass: `withAnchor`'s `if (!afterBox) return paragraph;` dropped
  // (old seeds 597, 1152, 1379, 1541): `### ^id1`, `4. ^id1` read the id
  // as the block's text. The listed blank-only family gives only tasks an id.
  const breakOnly = (blank: string): EditorNode[] =>
    blank === '' ? [{ type: 'hardBreak' }] : [text(blank), { type: 'hardBreak' }];

  it.each(['', ' '])('a heading, an item and a paragraph of %j then a break', (blank) => {
    const content = breakOnly(blank);
    expectReadBack(
      note(
        { type: 'heading', attrs: { level: 3, anchor: 'h1' }, content },
        bullets([paragraph(text('k'))]),
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            { type: 'listItem', content: [paragraph(text('k'))] },
            { type: 'listItem', attrs: { anchor: 'i1' }, content: [paragraph(...content)] },
          ],
        },
        { type: 'paragraph', attrs: { anchor: 'p1' }, content },
      ),
    );
  });
});
