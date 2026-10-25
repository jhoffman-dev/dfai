import { describe, expect, it } from 'vitest';
import type { EditorDocument, EditorNode } from '@dfai/domain';
import { parseMarkdownBody, serializeMarkdownBody } from './markdown-blocks.ts';

/*
 * Adversarial checks on an image's `|width` (#568, PR #570): random image
 * markdown, seeded, must keep every byte but the size token through a save.
 */

/** mulberry32: a small seeded generator, so a failure names the seed that made it. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, from: readonly T[]): T =>
  from[Math.floor(rng() * from.length)]!;

const ALT_PIECES = [
  'chart',
  'a b',
  '|',
  '\\|',
  '\\[x\\]',
  '[y]',
  '\\\\',
  '😀',
  'café',
  'x',
  '12',
  '|300',
  '|40x30',
  ' ',
  '*em*',
  '&amp;',
  'ü',
  '\\*',
] as const;
const DESTINATIONS = [
  'a.png',
  'attachments/Q3%20chart.png',
  '<my pic.png>',
  'a(1).png',
  '<a (b).png>',
  'https://example.com/x.svg',
  '../up/one.png',
] as const;
const TITLES = ['', ' "The title"', " 'single'", ' (paren)', ' "with \\"quote\\""'] as const;
const SIZES = ['', '|300', '|400x300', '|64', '|1200'] as const;

function randomImage(rng: () => number): string {
  const count = Math.floor(rng() * 4);
  let alt = '';
  for (let i = 0; i < count; i += 1) alt += pick(rng, ALT_PIECES);
  const inner = `![${alt}${pick(rng, SIZES)}](${pick(rng, DESTINATIONS)}${pick(rng, TITLES)})`;
  return rng() < 0.2 ? `[${inner}](https://example.com/page)` : inner;
}

const mapImages = (node: EditorNode, change: (image: EditorNode) => EditorNode): EditorNode =>
  node.type === 'image'
    ? change(node)
    : node.content === undefined
      ? node
      : { ...node, content: node.content.map((child) => mapImages(child, change)) };

function saveWith(original: string, change: (doc: EditorDocument) => EditorDocument): string {
  const parsed = parseMarkdownBody(original);
  return serializeMarkdownBody({ originalBody: original, parsed, doc: change(parsed.doc) });
}

const resizedTo = (width: number | null) => (doc: EditorDocument) =>
  mapImages(doc as EditorNode, (image) => ({
    ...image,
    attrs: { ...image.attrs, width, height: null },
  })) as EditorDocument;

const typedAtEnd = (doc: EditorDocument): EditorDocument => ({
  ...doc,
  content: doc.content.map((block, index) =>
    index === doc.content.length - 1 && block.type === 'paragraph'
      ? { ...block, content: [...(block.content ?? []), { type: 'text', text: ' typed' }] }
      : block,
  ),
});

function imagesOf(markdown: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: EditorNode) => {
    if (node.type === 'image') found.push({ ...node.attrs });
    node.content?.forEach(visit);
  };
  visit(parseMarkdownBody(markdown).doc as EditorNode);
  return found;
}

const withoutSize = (attrs: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== 'width' && key !== 'height'));

/** Lines that read back as exactly one image in a paragraph, so the invariants are about it. */
function samples(seed: number, count: number): string[] {
  const rng = seeded(seed);
  const lines: string[] = [];
  while (lines.length < count) {
    const line = `Before ${randomImage(rng)} after`;
    if (imagesOf(`${line}\n`).length === 1) lines.push(line);
  }
  return lines;
}

const SEED = 568;
const SAMPLES = samples(SEED, 300);

describe('an image’s |width, over random image markdown (seed 568)', () => {
  it('is written back byte-identical when nothing is edited', () => {
    const changed = SAMPLES.map((line) => `${line}\n`).filter(
      (body) => saveWith(body, (doc) => doc) !== body,
    );
    expect(changed).toEqual([]);
  });

  it('keeps every image byte when words after it are typed', () => {
    const changed = SAMPLES.map((line) => `${line}\n`).filter(
      (body) => saveWith(body, typedAtEnd) !== `${body.trimEnd()} typed\n`,
    );
    expect(changed).toEqual([]);
  });

  it('a resize changes the width and nothing else the image reads as', () => {
    const lost = SAMPLES.map((line) => `${line}\n`).filter((body) => {
      const [before] = imagesOf(body);
      const [after] = imagesOf(saveWith(body, resizedTo(480)));
      return (
        after === undefined ||
        after['width'] !== 480 ||
        JSON.stringify(withoutSize(after)) !== JSON.stringify(withoutSize(before!))
      );
    });
    expect(lost).toEqual([]);
  });

  it('a resize leaves the words either side of the image byte-identical', () => {
    const moved = SAMPLES.map((line) => `${line}\n`).filter((body) => {
      const saved = saveWith(body, resizedTo(480));
      return !saved.startsWith('Before ') || !saved.endsWith(' after\n');
    });
    expect(moved).toEqual([]);
  });
});

describe('an image’s |width, in the places an image can be', () => {
  const TABLE = '| Photo | Notes |\n| - | - |\n| ![shot](a.png) | kept |\n';

  it('a resize in a table cell keeps the table a table, with the image in its cell', () => {
    const saved = saveWith(TABLE, resizedTo(480));
    const doc = parseMarkdownBody(saved).doc;
    expect(doc.content[0]?.type).toBe('table');
    expect(imagesOf(saved)).toEqual([
      { src: 'a.png', alt: 'shot', title: null, width: 480, height: null },
    ]);
  });

  it('a resize in a table cell escapes the size pipe as the cell needs', () => {
    expect(saveWith(TABLE, resizedTo(480))).toBe(
      '| Photo | Notes |\n| - | - |\n| ![shot\\|480](a.png) | kept |\n',
    );
  });
});

describe('an image’s |width, as its digits were written', () => {
  it.each([
    ['a leading zero', '![shot|0400](a.png)'],
    ['a zero height', '![shot|400x0](a.png)'],
  ])('keeps %s byte-identical when other words in its paragraph are edited', (_label, line) => {
    expect(saveWith(`${line}\n`, typedAtEnd)).toBe(`${line} typed\n`);
  });

  it.each([
    ['a code span holding a pipe', '![`code|300`](a.png)'],
    ['a pipe written as an entity', '![shot&#124;300](a.png)'],
  ])('a resize of an image whose alt has %s keeps its alt text', (_label, line) => {
    const [before] = imagesOf(`${line}\n`);
    const [after] = imagesOf(saveWith(`${line}\n`, resizedTo(480)));
    expect(after?.['alt']).toBe(before?.['alt']);
  });
});

describe('alt text typed in the alt field', () => {
  it('reads back as it was typed, even when it ends in what looks like a size', () => {
    const doc: EditorDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'image', attrs: { src: 'a.png', alt: 'Route 66|2024', title: null } }],
        },
      ],
    };
    const saved = serializeMarkdownBody({ originalBody: '', parsed: parseMarkdownBody(''), doc });
    expect(imagesOf(saved)[0]).toEqual({ src: 'a.png', alt: 'Route 66|2024', title: null });
  });
});
