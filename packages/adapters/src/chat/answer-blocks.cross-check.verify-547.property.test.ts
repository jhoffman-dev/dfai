import { describe, expect, it } from 'vitest';
import { citeAnswer } from '@dfai/domain';
import type { Nodes } from 'mdast';
import { parseBodyToMdast } from '../markdown/markdown-blocks.ts';

/**
 * Verification of PR #547 (#37): Ask's block reader against the editor's
 * parser. Ask exempts headings, rules and fenced code from the citation rule;
 * a word the editor draws as prose (a paragraph, an item, a quote, a table)
 * must not be exempt in Ask, nor go undrawn — else a saved chat shows the
 * reader an uncited claim Ask never flagged.
 */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Line shapes a model writes; `W` becomes a word of its own, `w<n>`. */
const SHAPES = [
  'W',
  '- W',
  '1. W',
  '2. W',
  '  - W',
  '> W',
  '> - W',
  '# W',
  '===',
  '---',
  '-',
  '```',
  '  ```',
  '> ```',
  '| W | W |',
  '|---|---|',
  '',
  '***',
];

/** Where the editor draws each word: in a heading, in code, or as prose. */
function editorKinds(node: Nodes, under: string, out: Map<string, string>): void {
  const here = node.type === 'heading' || node.type === 'code' ? node.type : under;
  if ('value' in node && typeof node.value === 'string') {
    for (const word of node.value.match(/w\d+/g) ?? []) out.set(word, here);
  }
  if ('children' in node)
    for (const child of node.children as Nodes[]) editorKinds(child, here, out);
}

/**
 * The words the editor draws in fenced code, which Ask reads too and must not
 * judge. Indented code is left out: Ask does not read it as code (#849).
 */
function fencedWords(answer: string, node: Nodes, out: Set<string>): void {
  if (node.type === 'code') {
    const source = answer.slice(node.position?.start.offset, node.position?.end.offset);
    // An indented code block may start with a fence's marks, as its own first line.
    const first = (source.split('\n')[0] ?? '').replace(/^[\s>]*/, '');
    if (/^(?:```|~~~)/.test(first) && !node.value.startsWith(first))
      for (const word of node.value.match(/w\d+/g) ?? []) out.add(word);
  }
  if ('children' in node)
    for (const child of node.children as Nodes[]) fencedWords(answer, child, out);
}

/** Where Ask puts each word it draws: the kind of its block. */
function askKinds(answer: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of citeAnswer(answer)) {
    for (const piece of block.inline) {
      const text = 'text' in piece ? piece.text : piece.label;
      for (const word of text.match(/w\d+/g) ?? []) out.set(word, block.kind);
    }
  }
  return out;
}

/**
 * How the editor reads the fences opened inside a list item: `closed` when
 * one ends at its own closing run inside the item, `carried on` when the item
 * then says more after it. Ask reads both on a path of its own.
 */
function itemFences(answer: string, node: Nodes, inItem = false): string[] {
  const here = inItem || node.type === 'listItem';
  const children = 'children' in node ? (node.children as Nodes[]) : [];
  const found = children.flatMap((child) => itemFences(answer, child, here));
  if (node.type === 'listItem') {
    children.forEach((child, at) => {
      if (child.type !== 'code') return;
      const source = answer.slice(child.position?.start.offset, child.position?.end.offset);
      const lines = source.split('\n');
      if (lines.length < 2 || !/^`{3,}$/.test(lines.at(-1)!.trim())) return;
      found.push('closed');
      if (at < children.length - 1) found.push('carried on');
    });
  }
  return found;
}

/** An answer of these shapes, each `W` its own word. */
function answerOf(shapes: readonly string[]): string {
  let word = 0;
  return shapes.map((shape) => shape.replace(/W/g, () => `w${word++}`)).join('\n');
}

/** What a fence in a list item turns on: the item, the fence at its text or not, and what follows. */
const ITEM_FENCE_SHAPES = ['- W', '1. W', '  - W', '  ```', '```', '  W', ''];

/** What a line under a quote turns on: a setext underline there is lazy text, not a heading (#831). */
const QUOTE_SETEXT_SHAPES = ['W', '> W', '> - W', '> | W |', '> ```', '===', '---', '-', ''];

/**
 * What follows an item nested in another turns on (#845): a fence at the
 * nested item's text or the outer one's, and what the outer list does next.
 */
const NESTED_ITEM = ['- W', '  - W'];
const NESTED_ITEM_SHAPES = ['    ```', '  ```', '```', '- W', '1. W', '  W', ''];

/**
 * What follows an item in a quote turns on (#845): the quote ending in a rule
 * or a fence, in the item or not, and a line under it that may be lazy; an
 * empty item takes none, so the quote after it starts afresh.
 */
const QUOTED_ITEMS = [['> - W'], ['> -']];
const QUOTED_ITEM_SHAPES = ['W', '> W', '> ---', '> ===', '>   ```', '> ```', '===', '-', ''];

/**
 * What a quote that breaks into a paragraph turns on (#845): the editor starts
 * no empty item on its first line, so what follows is the paragraph's text.
 */
const QUOTE_UNDER_PARAGRAPH = ['W', '> -'];
const QUOTE_UNDER_PARAGRAPH_SHAPES = [
  '>   3) W',
  '>     ~~~~ py',
  '>     ### W ##',
  '>   W',
  '> ```',
  'W',
  '',
];

/** The openers of a list item, each followed by every three lines of the item-fence shapes. */
const ITEM_OPENERS = ['- W', '1. W', '  - W'];

/** Every answer of these shapes and this many lines. */
function everyAnswer(shapes: readonly string[], lines: number): string[][] {
  if (lines === 0) return [[]];
  return everyAnswer(shapes, lines - 1).flatMap((head) => shapes.map((last) => [...head, last]));
}

/** Every answer that opens with `opening` and goes on with this many lines of these shapes. */
function everyAnswerAfter(
  opening: readonly string[],
  shapes: readonly string[],
  lines: number,
): string[] {
  return everyAnswer(shapes, lines).map((rest) => answerOf([...opening, ...rest]));
}

/**
 * Every answer of one or two lines, so every shape meets every other one
 * beneath it (a setext rule under a word, a fence opened in a quote); every
 * answer of three and four lines over the shapes a fence in a list item turns
 * on, so one closes inside the item and the item carries on after it; every
 * answer of three lines over the shapes a quote's lazy line turns on, and
 * after an item nested in another or an item in a quote; and 400
 * seeded answers of three or four lines over every shape for the rest. It was
 * 3000 random answers of one to four lines, which left some pairs undrawn and
 * cost seconds when the gate shared the machine (#820).
 */
function answers(): string[] {
  const random = mulberry32(547);
  const pick = () => SHAPES[Math.floor(random() * SHAPES.length)] as string;
  return [
    ...[1, 2].flatMap((lines) => everyAnswer(SHAPES, lines).map(answerOf)),
    ...everyAnswer(ITEM_FENCE_SHAPES, 3).map(answerOf),
    ...ITEM_OPENERS.flatMap((opener) => everyAnswerAfter([opener], ITEM_FENCE_SHAPES, 3)),
    ...everyAnswer(QUOTE_SETEXT_SHAPES, 3).map(answerOf),
    ...everyAnswerAfter(NESTED_ITEM, NESTED_ITEM_SHAPES, 3),
    ...QUOTED_ITEMS.flatMap((opening) => everyAnswerAfter(opening, QUOTED_ITEM_SHAPES, 3)),
    ...everyAnswerAfter(QUOTE_UNDER_PARAGRAPH, QUOTE_UNDER_PARAGRAPH_SHAPES, 3),
    ...Array.from({ length: 400 }, () =>
      answerOf(Array.from({ length: 3 + Math.floor(random() * 2) }, pick)),
    ),
  ];
}

describe('Ask’s blocks against the editor’s (PR #547)', () => {
  it('judges every word the editor draws as prose, and none it draws as fenced code, on every short answer, every item fence, every quote’s lazy line, nested and quoted items, and seeded longer ones', () => {
    const escaped: string[] = [];
    const judgedCode: string[] = [];
    const drawn = new Set<string>();
    for (const answer of answers()) {
      const editor = new Map<string, string>();
      const tree = parseBodyToMdast(answer);
      for (const path of itemFences(answer, tree)) drawn.add(path);
      editorKinds(tree, 'prose', editor);
      const fenced = new Set<string>();
      fencedWords(answer, tree, fenced);
      const ask = askKinds(answer);
      for (const [token, kind] of editor) {
        const judged = ['paragraph', 'item', 'quote', 'table'].includes(ask.get(token) ?? '');
        if (kind === 'prose' && !judged)
          escaped.push(`${JSON.stringify(answer)}: ${token} is ${ask.get(token) ?? 'not drawn'}`);
        if (fenced.has(token) && judged)
          judgedCode.push(`${JSON.stringify(answer)}: ${token} is ${ask.get(token)}`);
      }
    }
    expect(escaped.slice(0, 5)).toEqual([]);
    expect(judgedCode.slice(0, 5)).toEqual([]);
    expect([...drawn].sort()).toEqual(['carried on', 'closed']);
  });
});
