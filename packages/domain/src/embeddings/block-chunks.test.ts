import { describe, expect, it } from 'vitest';
import type { EditorDocument, EditorNode } from '../markdown/editor-node.ts';
import {
  blockChunks,
  CHUNK_EXCERPT_LENGTH,
  chunkExcerpt,
  halvedChunk,
  MAX_CHUNK_CHARACTERS,
  numbered,
  passageOf,
  type BlockChunk,
} from './block-chunks.ts';
import { passageDigest } from './passage-digest.ts';

const text = (value: string): EditorNode => ({ type: 'text', text: value });
const paragraph = (value: string, anchor?: string): EditorNode => ({
  type: 'paragraph',
  ...(anchor !== undefined && { attrs: { anchor } }),
  ...(value === '' ? {} : { content: [text(value)] }),
});
const heading = (level: number, value: string, anchor?: string): EditorNode => ({
  type: 'heading',
  attrs: { level, ...(anchor !== undefined && { anchor }) },
  content: [text(value)],
});
const item = (value: string, anchor?: string, ...nested: EditorNode[]): EditorNode => ({
  type: 'listItem',
  ...(anchor !== undefined && { attrs: { anchor } }),
  content: [paragraph(value), ...nested],
});
const bullets = (...items: EditorNode[]): EditorNode => ({ type: 'bulletList', content: items });
const doc = (...content: EditorNode[]): EditorDocument => ({ type: 'doc', content });
const cell = (value: string): EditorNode => ({ type: 'tableCell', content: [paragraph(value)] });
const row = (...cells: string[]): EditorNode => ({ type: 'tableRow', content: cells.map(cell) });

const wordsOf = (chunks: readonly BlockChunk[]) => chunks.map((chunk) => chunk.words);

describe('blockChunks', () => {
  it('cuts a note into its headings, paragraphs and list items, in order, numbered from 0', () => {
    const chunks = blockChunks({
      title: 'Standup',
      doc: doc(
        heading(1, 'Payroll'),
        paragraph('Mara Quill moves pay day to Friday.'),
        bullets(
          item('Tell the team', undefined, bullets(item('By email'))),
          item('Update the wiki'),
        ),
      ),
    });
    expect(wordsOf(chunks)).toEqual([
      'Payroll',
      'Mara Quill moves pay day to Friday.',
      'Tell the team',
      'By email',
      'Update the wiki',
    ]);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2, 3, 4]);
  });

  it('puts the note title and the heading above in front of a block’s words', () => {
    const [, body] = blockChunks({
      title: 'Standup',
      doc: doc(heading(2, 'Payroll'), paragraph('Pay moves to Friday.')),
    });
    expect(body?.heading).toBe('Payroll');
    expect(passageOf(body!)).toBe('Standup\nPayroll\nPay moves to Friday.');
  });

  it('gives a heading its own words as its heading, and only the title in front', () => {
    const [chunk] = blockChunks({ title: 'Standup', doc: doc(heading(2, 'Payroll')) });
    expect(chunk?.heading).toBe('Payroll');
    expect(passageOf(chunk!)).toBe('Standup\nPayroll');
  });

  it('makes no chunk of a heading that only repeats the title, unless it has an id', () => {
    const plain = blockChunks({
      title: 'Garden',
      doc: doc(heading(1, 'Garden'), paragraph('Bees.')),
    });
    expect(wordsOf(plain)).toEqual(['Bees.']);
    const named = blockChunks({ title: 'Garden', doc: doc(heading(1, 'Garden', 'h1')) });
    expect(named).toMatchObject([{ words: 'Garden', anchor: 'h1' }]);
  });

  it('does not say a heading twice when it repeats the title', () => {
    const [body] = blockChunks({
      title: 'Garden',
      doc: doc(heading(1, 'Garden'), paragraph('Bees.')),
    });
    expect(body?.heading).toBe('Garden');
    expect(passageOf(body!)).toBe('Garden\nBees.');
  });

  it('gives a block before any heading no heading, and only the title as context', () => {
    const [chunk] = blockChunks({ title: 'Idea', doc: doc(paragraph('Bees in the garden.')) });
    expect(chunk?.heading).toBeNull();
    expect(chunk?.context).toBe('Idea');
  });

  it('keeps a block’s own id, for a link to it', () => {
    const chunks = blockChunks({
      title: 'Plans',
      doc: doc(
        paragraph('Pack the tent', 'p1'),
        bullets(item('Pegs', 'i1')),
        heading(2, 'Go', 'h1'),
      ),
    });
    expect(chunks.map((chunk) => chunk.anchor)).toEqual(['p1', 'i1', 'h1']);
  });

  it('gives a second holder of an id none: the id names the first (ADR-0022)', () => {
    const chunks = blockChunks({
      title: 'Plans',
      doc: doc(paragraph('First', 'dup'), paragraph('Second', 'dup')),
    });
    expect(chunks.map((chunk) => chunk.anchor)).toEqual(['dup', null]);
  });

  it('embeds a quote, a callout, a table and code whole, with spaces between their parts', () => {
    const chunks = blockChunks({
      title: 'Notes',
      doc: doc(
        { type: 'blockquote', content: [paragraph('Said once.'), paragraph('Said twice.')] },
        { type: 'callout', content: [paragraph('Careful')] },
        { type: 'table', content: [row('Name', 'Role'), row('Tobias Fenn', 'Keeper')] },
        { type: 'codeBlock', content: [text('const pay = 1;')] },
      ),
    });
    expect(wordsOf(chunks)).toEqual([
      'Said once. Said twice.',
      'Careful',
      'Name Role Tobias Fenn Keeper',
      'const pay = 1;',
    ]);
  });

  it('passes over a query block, raw markdown, a rule and an empty paragraph', () => {
    const chunks = blockChunks({
      title: 'Notes',
      doc: doc(
        { type: 'queryBlock', attrs: { source: 'FROM tasks' } },
        { type: 'rawBlock', content: [text('<div>raw</div>')] },
        { type: 'horizontalRule' },
        paragraph(''),
        paragraph('   '),
        heading(1, ' '),
        paragraph('Kept.'),
      ),
    });
    expect(wordsOf(chunks)).toEqual(['Kept.']);
  });

  it('gives a list item its own lines but not the items nested under it', () => {
    const multi: EditorNode = {
      type: 'listItem',
      content: [paragraph('First line'), paragraph('second paragraph'), bullets(item('Nested'))],
    };
    const chunks = blockChunks({ title: 'T', doc: doc(bullets(multi)) });
    expect(wordsOf(chunks)).toEqual(['First line second paragraph', 'Nested']);
  });

  it('reads a task item like a list item', () => {
    const task: EditorNode = {
      type: 'taskItem',
      attrs: { checked: false, anchor: 't1' },
      content: [paragraph('Send the contract')],
    };
    const chunks = blockChunks({ title: 'T', doc: doc({ type: 'taskList', content: [task] }) });
    expect(chunks).toMatchObject([{ words: 'Send the contract', anchor: 't1' }]);
  });

  it('squeezes runs of whitespace in the title and the words', () => {
    const [chunk] = blockChunks({ title: '  Two   words ', doc: doc(paragraph('a \n\t b')) });
    expect(chunk?.context).toBe('Two words');
    expect(chunk?.words).toBe('a b');
  });

  it('cuts a block longer than a chunk at spaces, each part keeping its id and heading', () => {
    const long = Array.from({ length: 400 }, (_, at) => `word${at}`).join(' ');
    const chunks = blockChunks({ title: 'T', doc: doc(heading(1, 'H'), paragraph(long, 'p1')) });
    const parts = chunks.slice(1);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.words.length).toBeLessThanOrEqual(MAX_CHUNK_CHARACTERS);
      expect(part).toMatchObject({ anchor: 'p1', heading: 'H' });
      expect(part.words.startsWith('word')).toBe(true);
    }
    expect(parts.map((part) => part.words).join(' ')).toBe(long);
  });

  it('cuts a single word longer than a chunk where it must', () => {
    const blob = 'x'.repeat(MAX_CHUNK_CHARACTERS * 2 + 5);
    const chunks = blockChunks({ title: 'T', doc: doc(paragraph(blob)) });
    expect(chunks.map((chunk) => chunk.words.length)).toEqual([
      MAX_CHUNK_CHARACTERS,
      MAX_CHUNK_CHARACTERS,
      5,
    ]);
  });

  it('digests the whole passage, so a renamed note or heading re-embeds, and nothing else does', () => {
    const before = blockChunks({ title: 'A', doc: doc(heading(1, 'H'), paragraph('Same')) });
    const again = blockChunks({ title: 'A', doc: doc(heading(1, 'H'), paragraph('Same')) });
    const renamed = blockChunks({ title: 'B', doc: doc(heading(1, 'H'), paragraph('Same')) });
    const moved = blockChunks({ title: 'A', doc: doc(heading(1, 'K'), paragraph('Same')) });
    expect(again[1]?.digest).toBe(before[1]?.digest);
    expect(renamed[1]?.digest).not.toBe(before[1]?.digest);
    expect(moved[1]?.digest).not.toBe(before[1]?.digest);
    expect(before[1]?.digest).toBe(passageDigest('A\nH\nSame'));
  });

  it('keeps an unchanged block’s digest when a block is added above it', () => {
    const before = blockChunks({ title: 'A', doc: doc(paragraph('Kept')) });
    const after = blockChunks({ title: 'A', doc: doc(paragraph('New'), paragraph('Kept')) });
    expect(after[1]?.digest).toBe(before[0]?.digest);
    expect(after[1]?.ordinal).toBe(1);
  });

  it('cuts nothing from an empty note', () => {
    expect(blockChunks({ title: 'Empty', doc: doc() })).toEqual([]);
  });
});

describe('halvedChunk', () => {
  const [chunk] = blockChunks({
    title: 'T',
    doc: doc(heading(1, 'H'), paragraph('one two three four', 'p1')),
  }).slice(1);

  it('splits the words at the last space before their middle, keeping the block’s id and heading', () => {
    const halves = halvedChunk(chunk!);
    expect(halves?.map((half) => half.words)).toEqual(['one two', 'three four']);
    expect(halves?.every((half) => half.anchor === 'p1' && half.heading === 'H')).toBe(true);
    expect(halves?.map((half) => half.digest)).toEqual([
      passageDigest('T\nH\none two'),
      passageDigest('T\nH\nthree four'),
    ]);
  });

  it('cuts an unspaced run in the middle', () => {
    const [run] = blockChunks({ title: 'T', doc: doc(paragraph('abcdef')) });
    expect(halvedChunk(run!)?.map((half) => half.words)).toEqual(['abc', 'def']);
  });

  it('cannot halve a single character', () => {
    const [one] = blockChunks({ title: 'T', doc: doc(paragraph('x')) });
    expect(halvedChunk(one!)).toBeNull();
  });
});

describe('numbered', () => {
  it('numbers chunks from 0 in the order given', () => {
    const chunks = blockChunks({ title: 'T', doc: doc(paragraph('a'), paragraph('b')) });
    expect(numbered([chunks[1]!, chunks[0]!]).map((chunk) => [chunk.words, chunk.ordinal])).toEqual(
      [
        ['b', 0],
        ['a', 1],
      ],
    );
  });
});

describe('chunkExcerpt', () => {
  it('shows a short block whole', () => {
    expect(chunkExcerpt({ words: 'Short.' })).toBe('Short.');
  });

  it('cuts a long one to the excerpt length, ending in an ellipsis', () => {
    const excerpt = chunkExcerpt({ words: 'a '.repeat(CHUNK_EXCERPT_LENGTH) });
    expect(excerpt.length).toBeLessThanOrEqual(CHUNK_EXCERPT_LENGTH);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

describe('passageOf', () => {
  it('is the words alone when there is no context', () => {
    expect(passageOf({ context: '', words: 'w' })).toBe('w');
  });
});
