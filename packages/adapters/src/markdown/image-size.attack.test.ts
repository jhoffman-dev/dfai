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

/** The parts an image line is drawn from. */
interface Drawn {
  readonly pieces: readonly string[];
  readonly size: string;
  readonly destination: string;
  readonly title: string;
  readonly linked: boolean;
}

const lineOf = ({ pieces, size, destination, title, linked }: Drawn): string => {
  const inner = `![${pieces.join('')}${size}](${destination}${title})`;
  return `Before ${linked ? `[${inner}](https://example.com/page)` : inner} after`;
};

/**
 * The alt pieces that end in a pipe or a size: whether that pipe starts a size
 * turns on the backslashes before it (`readImageMarkdown`), which the piece
 * before decides.
 */
const PIPE_ENDS: readonly string[] = ALT_PIECES.filter((piece) => /\|[\dx]*$/.test(piece));

/**
 * What a line holds that the size token turns on: what the alt ends in right
 * before the size, the piece before a pipe-ended last one, and each pair of
 * the size, destination, title and link around it — so a run can show it drew
 * every one.
 */
function shapesOf({ pieces, size, destination, title, linked }: Drawn): string[] {
  const [s, d, t] = [size, destination, title].map((part) => JSON.stringify(part));
  const last = pieces[pieces.length - 1] ?? null;
  const beforeLast = pieces[pieces.length - 2] ?? null;
  return [
    `${pieces.length} pieces`,
    `${JSON.stringify(last)} then ${s}`,
    ...(last !== null && PIPE_ENDS.includes(last)
      ? [`${JSON.stringify(beforeLast)} before ${JSON.stringify(last)}`]
      : []),
    `${s} to ${d}`,
    `${s} titled ${t}`,
    `${d} titled ${t}`,
    ...[s, d, t].map((part) => `linked ${linked} ${part}`),
  ];
}

function randomDrawn(rng: () => number): Drawn {
  const count = Math.floor(rng() * 4);
  const pieces = Array.from({ length: count }, () => pick(rng, ALT_PIECES));
  return {
    pieces,
    size: pick(rng, SIZES),
    destination: pick(rng, DESTINATIONS),
    title: pick(rng, TITLES),
    linked: rng() < 0.2,
  };
}

/**
 * Every alt piece last before every size (and no alt before each), 95 lines,
 * which 300 seeds do not reach. The index turns the destination, the title and
 * the link so that every pair of them, and of each with the size, is met too.
 */
function everyPieceBeforeEverySize(): Drawn[] {
  const ends = [null, ...ALT_PIECES];
  return ends.flatMap((end, e) =>
    SIZES.map((size, s) => {
      const at = e * SIZES.length + s;
      const before = Array.from(
        { length: end === null ? 0 : (at + 1) % 3 },
        (_, k) => ALT_PIECES[(e + 5 * k + s + 1) % ALT_PIECES.length]!,
      );
      return {
        pieces: end === null ? [] : [...before, end],
        size,
        destination: DESTINATIONS[at % DESTINATIONS.length]!,
        title: TITLES[(at + Math.floor(at / DESTINATIONS.length)) % TITLES.length]!,
        linked: Math.floor(at / 2) % 2 === 1,
      };
    }),
  );
}

/**
 * Every piece (and none) before each pipe-ended last piece, 76 lines: an
 * escaped backslash then a pipe reads as a size where a lone backslash does
 * not. The index turns the size, destination, title and link.
 */
function everyPieceBeforeAPipe(): Drawn[] {
  return PIPE_ENDS.flatMap((last, q) =>
    [null, ...ALT_PIECES].map((before, b) => {
      const at = q * (ALT_PIECES.length + 1) + b;
      return {
        pieces: before === null ? [last] : [before, last],
        size: SIZES[(b + q) % SIZES.length]!,
        destination: DESTINATIONS[at % DESTINATIONS.length]!,
        title: TITLES[at % TITLES.length]!,
        linked: at % 3 === 0,
      };
    }),
  );
}

/** Every shape the property turns on: what the lines below are shown to draw. */
const EVERY_SHAPE = [
  ...PIPE_ENDS.flatMap((last) =>
    [null, ...ALT_PIECES].map(
      (before) => `${JSON.stringify(before)} before ${JSON.stringify(last)}`,
    ),
  ),
  ...[0, 1, 2, 3].map((count) => `${count} pieces`),
  ...[null, ...ALT_PIECES].flatMap((end) =>
    SIZES.map((size) => `${JSON.stringify(end)} then ${JSON.stringify(size)}`),
  ),
  ...SIZES.flatMap((size) => [
    ...DESTINATIONS.map((d) => `${JSON.stringify(size)} to ${JSON.stringify(d)}`),
    ...TITLES.map((t) => `${JSON.stringify(size)} titled ${JSON.stringify(t)}`),
  ]),
  ...DESTINATIONS.flatMap((d) =>
    TITLES.map((t) => `${JSON.stringify(d)} titled ${JSON.stringify(t)}`),
  ),
  ...[true, false].flatMap((linked) =>
    [...SIZES, ...DESTINATIONS, ...TITLES].map(
      (part) => `linked ${linked} ${JSON.stringify(part)}`,
    ),
  ),
];

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

/** Whether a line reads back as exactly one image in a paragraph, so the invariants are about it. */
const oneImage = (drawn: Drawn) => imagesOf(`${lineOf(drawn)}\n`).length === 1;

/** Seeded lines that read back as one image each. */
function samples(seed: number, count: number): Drawn[] {
  const rng = seeded(seed);
  const drawn: Drawn[] = [];
  while (drawn.length < count) {
    const next = randomDrawn(rng);
    if (oneImage(next)) drawn.push(next);
  }
  return drawn;
}

const SEED = 568;
// Each line costs a parse and a save in every test, and the saves of an edit
// are the slow part (#854): 300 seeded lines took 5 s under load and still
// missed shapes the listed lines draw. A few seeded ones stay for what the
// lists do not think of.
const DRAWN = [
  ...everyPieceBeforeEverySize().filter(oneImage),
  ...everyPieceBeforeAPipe().filter(oneImage),
  ...samples(SEED, 10),
];
const SAMPLES = DRAWN.map(lineOf);

describe('an image’s |width, over random image markdown (seed 568)', () => {
  it('draws every shape the size token turns on', () => {
    const drawn = new Set(DRAWN.flatMap(shapesOf));
    expect(EVERY_SHAPE.filter((shape) => !drawn.has(shape))).toEqual([]);
  });

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
