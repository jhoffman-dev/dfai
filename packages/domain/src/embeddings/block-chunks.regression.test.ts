import { describe, expect, it } from 'vitest';
import type { EditorDocument, EditorNode } from '../markdown/editor-node.ts';
import {
  blockChunks,
  CHUNK_EXCERPT_LENGTH,
  chunkExcerpt,
  halvedChunk,
  MAX_CHUNK_CHARACTERS,
  type BlockChunk,
} from './block-chunks.ts';
import { topByCosine } from './cosine-ranking.ts';

/*
 * Regression tests for review and attack findings on the embeddings cache and semantic search (#33).
 * Each names the invariant it holds the chunker or the ranking to.
 */

const text = (value: string): EditorNode => ({ type: 'text', text: value });
const paragraph = (...content: EditorNode[]): EditorNode => ({ type: 'paragraph', content });
const doc = (...content: EditorNode[]): EditorDocument => ({ type: 'doc', content });
const callout = (title: string, ...content: EditorNode[]): EditorNode => ({
  type: 'callout',
  attrs: { kind: 'warning', title, fold: null },
  content,
});

/** A lone UTF-16 surrogate: a character cut in half, which no tokenizer or JSON reader takes. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const wordsOf = (chunks: readonly BlockChunk[]) => chunks.map((chunk) => chunk.words);

describe('cutting never splits a character', () => {
  it('a long run of emoji with no spaces is cut between characters, not inside one', () => {
    // One letter first puts every emoji's two code units across an even cut at 1,200.
    const words = `a${'🐝'.repeat(MAX_CHUNK_CHARACTERS)}`;
    const chunks = blockChunks({ title: 'Bees', doc: doc(paragraph(text(words))) });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.words).not.toMatch(LONE_SURROGATE);
  });

  it('CJK past the BMP with no spaces is cut between characters, not inside one', () => {
    const words = `中${'𠀋'.repeat(MAX_CHUNK_CHARACTERS)}`;
    const chunks = blockChunks({ title: '笔记', doc: doc(paragraph(text(words))) });
    for (const chunk of chunks) expect(chunk.words).not.toMatch(LONE_SURROGATE);
  });

  it('an excerpt cut at its length does not end in half an emoji', () => {
    // The excerpt keeps CHUNK_EXCERPT_LENGTH - 1 code units: an emoji straddles that cut.
    const words = `${'x'.repeat(CHUNK_EXCERPT_LENGTH - 2)}🐝 and the rest of the paragraph about bees`;
    expect(chunkExcerpt({ words })).not.toMatch(LONE_SURROGATE);
  });

  it('halving a one-emoji block the model refused does not split the emoji in two', () => {
    const [chunk] = blockChunks({ title: 'Bees', doc: doc(paragraph(text('🐝'))) });
    const halves = halvedChunk(chunk as BlockChunk);
    // Either it cannot be halved (one character), or each half is whole characters.
    for (const half of halves ?? []) expect(half.words).not.toMatch(LONE_SURROGATE);
  });
});

describe('every block shape says its words', () => {
  it('a callout with only a title is a chunk of its title', () => {
    const chunks = blockChunks({
      title: 'Garden',
      doc: doc(callout('Mind the bees behind the shed', { type: 'paragraph' })),
    });
    expect(wordsOf(chunks)).toEqual(['Mind the bees behind the shed']);
  });

  it('a callout chunk includes its title as well as its body', () => {
    const chunks = blockChunks({
      title: 'Garden',
      doc: doc(callout('Payday moves', paragraph(text('Mara Quill said Friday from June.')))),
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.words).toContain('Payday moves');
  });

  it('an embed (![[Other]]) is passed over, as the PR says embeds are', () => {
    const embed: EditorNode = {
      type: 'wikiLink',
      attrs: { target: 'Weekly review', heading: null, alias: null, embed: true },
    };
    const chunks = blockChunks({ title: 'Home', doc: doc(paragraph(embed)) });
    expect(wordsOf(chunks)).toEqual([]);
  });
});

describe('Obsidian %% comments are hidden, so not embedded or shown', () => {
  it('the words inside an inline %% comment are not in the chunk', () => {
    const chunks = blockChunks({
      title: 'Review',
      doc: doc(paragraph(text('Tobias Fenn did well %%salary to 91k, do not share%% this year'))),
    });
    expect(chunks.map((chunk) => chunk.words).join(' ')).not.toContain('salary');
  });

  it('a paragraph that is all one %% comment is not a chunk', () => {
    const chunks = blockChunks({
      title: 'Review',
      doc: doc(paragraph(text('%% private: Mara Quill is leaving in May %%'))),
    });
    expect(wordsOf(chunks)).toEqual([]);
  });
});

describe('a %% comment that spans blocks, and code', () => {
  it('a comment opened in one paragraph and closed in a later one hides the blocks between', () => {
    const chunks = blockChunks({
      title: 'Review',
      doc: doc(
        paragraph(text('Kept before. %% start of a private aside')),
        paragraph(text('Mara Quill is leaving in May.')),
        paragraph(text('end of it %% Kept after.')),
      ),
    });
    expect(wordsOf(chunks)).toEqual(['Kept before.', 'Kept after.']);
  });

  it('a comment never closed hides all that follows', () => {
    const chunks = blockChunks({
      title: 'Review',
      doc: doc(paragraph(text('Shown. %% never closed')), paragraph(text('Hidden too.'))),
    });
    expect(wordsOf(chunks)).toEqual(['Shown.']);
  });

  it('a %% inside a code block is code, not a comment', () => {
    const code: EditorNode = { type: 'codeBlock', content: [text('printf("100%%");')] };
    expect(wordsOf(blockChunks({ title: 'Notes', doc: doc(code) }))).toEqual(['printf("100%%");']);
  });
});

describe('ranking is never garbage', () => {
  const unit = (...values: number[]): Float32Array => {
    const length = Math.hypot(...values);
    return Float32Array.from(values.map((value) => value / length));
  };

  it('a NaN vector (a torn cache row) does not push a better match out of the top hits', () => {
    const torn = Float32Array.from([Number.NaN, Number.NaN]);
    const vectors = [unit(0, 1), torn, unit(1, 0.1), unit(1, 0)];
    const ranked = topByCosine({ query: unit(1, 0), vectors, limit: 2 });
    expect(ranked.map((hit) => hit.at)).toEqual([3, 2]);
  });

  it('no hit scores NaN', () => {
    const torn = Float32Array.from([Number.NaN, Number.NaN]);
    const ranked = topByCosine({ query: unit(1, 0), vectors: [torn, unit(1, 0)], limit: 5 });
    for (const hit of ranked) expect(Number.isFinite(hit.score)).toBe(true);
  });
});
