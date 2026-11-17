import { describe, expect, it } from 'vitest';
import { literatureHighlightReader } from '@dfai/application';
import {
  appendHighlights,
  BLOCK_ANCHOR_ATTR,
  commentLines,
  HIGHLIGHT_COLORS,
  HighlightNotReadBackError,
  readHighlights,
  splitFrontmatter,
  withHighlightComment,
  withoutHighlight,
  type HighlightAnchor,
  type HighlightView,
  type NewHighlight,
} from '@dfai/domain';
import { remarkMarkdown } from './markdown-port.ts';
import { noteBlocks } from './note-blocks.ts';

/**
 * Property (#523): whatever a literature note holds, however it was written
 * and edited by hand, DFAI's editor draws exactly its highlights, as their
 * comments read; saves it unedited byte for byte; and a comment typed in
 * place changes only that comment's bytes, after which the editor reads and
 * saves the note byte for byte again.
 */

/** mulberry32: a seeded random source, so every run draws the same notes. */
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

// HIGHLIGHT_EDITOR_SEED and HIGHLIGHT_EDITOR_RUNS run other notes, and more, by hand.
const random = seeded(Number(process.env['HIGHLIGHT_EDITOR_SEED'] ?? 20261023));
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const count = (max: number) => Math.floor(random() * (max + 1));
// Each note costs about 30 ms to write, save and draw (ten times that under
// coverage in CI), so 200 a test timed out under load (#854). Listed notes
// and comments (`EVERY_FILLER`, `EVERY_TYPED`) draw the rare shapes, and each
// test shows below that its notes drew every shape.
const RUNS = Number(process.env['HIGHLIGHT_EDITOR_RUNS'] ?? 15);

/** What the notes drawn so far hold that the property turns on. */
let seen = new Set<string>();
const saw = (shape: string) => seen.add(shape);

/** Starts a test's record of what its notes hold. */
function drawing(): Set<string> {
  seen = new Set();
  return seen;
}

const WORDS = [
  'warfare',
  '*bold*',
  '#tag',
  '==mark==',
  '%%',
  '%%hide%%',
  '50%%',
  '[[Larkspur Payroll]]',
  '![[Field notes]]',
  '<b>',
  '-->',
  '`code %%`',
  '^abc123',
  '\\',
  'é',
  '1.',
  '-',
  '> nested',
];

const SEPARATORS = [' ', '\n', '\n\n'];

/** Words for a quote, a comment, or a comment typed in place (`where`). */
function words(max: number, where: string): string {
  const drawn = Array.from({ length: 1 + count(max) }, () => pick(WORDS));
  const separator = pick(SEPARATORS);
  for (const word of drawn) saw(`${where} has ${word}`);
  if (drawn.length > 1) saw(`${where} joined by ${JSON.stringify(separator)}`);
  return drawn.join(separator);
}

const ANCHORS: (() => HighlightAnchor)[] = [
  () => ({
    kind: 'pdf',
    page: 1 + count(300),
    quote: { exact: `passage ${count(1e6)}`, prefix: '', suffix: '' },
    rects: [{ x: 0.1, y: random() * 0.5, width: 0.4, height: 0.02 }],
  }),
  () => ({
    kind: 'epub',
    cfi: `epubcfi(/6/${2 * (1 + count(40))}!/4/2/1:${count(300)})`,
    quote: { exact: `passage ${count(1e6)}`, prefix: '', suffix: '' },
  }),
  () => ({
    kind: 'kindle',
    location: { start: 1 + count(9000), end: null },
    annotationId: `AMZ-${count(1e6)}`,
  }),
];

function newHighlight(): NewHighlight {
  const area = random() < 0.2;
  const anchor: HighlightAnchor = area
    ? {
        kind: 'pdf' as const,
        page: 1 + count(9),
        quote: null,
        rects: [{ x: 0, y: 0, width: 1, height: 0.2 }],
      }
    : pick(ANCHORS)();
  saw(area ? 'area anchor' : `${anchor.kind} anchor`);
  const quote = area ? '' : words(8, 'quote');
  const image = area ? `attachments/Generated p${count(9)} area ${count(99)}.png` : null;
  const style = { mark: pick(['highlight', 'underline'] as const), color: pick(HIGHLIGHT_COLORS) };
  saw(`${style.mark} in ${style.color}`);
  const commented = random() < 0.7;
  saw(`commented ${commented}`);
  return {
    quote,
    ...(image !== null && { image }),
    anchor,
    style,
    ...(commented && { comment: words(6, 'comment') }),
  };
}

const INLINE = ['*bold*', '#tag', '%%aside%%', '[[Larkspur Payroll]]', '^abc123'];

// Prose never leaves a `%%` open: an append after one is refused (ADR-0043 §5), and nothing is drawn.
const prose = (inline: string) => `Prose with ${inline} in it.\n`;

const FILLER = [
  () => {
    const inline = pick(INLINE);
    saw(`prose with ${inline}`);
    return prose(inline);
  },
  () => '> A plain quote, no marker.\n',
  () => '- a list item ^li0001\n',
  () => '## A heading\n',
  () => '%%\nA hidden aside.\n%%\n',
  () => '| a | b |\n| - | - |\n| 1 | 2 |\n',
];

/** What stands before a note's highlights, and the shapes it holds. */
interface Filler {
  readonly text: string;
  readonly shapes: readonly string[];
}

/**
 * Every filler there is in two notes: prose with each of its inlines, and
 * each other filler. One in 30 fillers is a given prose, which seeded notes
 * would take a hundred or more to draw.
 */
const EVERY_FILLER: readonly Filler[] = [
  {
    text: INLINE.map(prose).join('\n'),
    shapes: ['filler 0', ...INLINE.map((inline) => `prose with ${inline}`)],
  },
  {
    text: FILLER.slice(1)
      .map((fill) => fill())
      .join('\n'),
    shapes: FILLER.slice(1).map((_, at) => `filler ${at + 1}`),
  },
];

/** Comments holding every word, one joined by each separator: what the first edits type. */
const EVERY_TYPED: readonly Filler[] = SEPARATORS.map((separator) => ({
  text: WORDS.join(separator),
  shapes: [
    ...WORDS.map((word) => `typed has ${word}`),
    `typed joined by ${JSON.stringify(separator)}`,
  ],
}));

/** The comment the `at`th edit types: a listed one, then seeded ones, some of them nothing. */
function typedFor(at: number): string {
  const listed = EVERY_TYPED[at];
  if (listed !== undefined) {
    listed.shapes.forEach(saw);
    return listed.text;
  }
  const typedNothing = random() < 0.15;
  if (typedNothing) saw('typed nothing');
  return typedNothing ? '' : words(6, 'typed');
}

/** The fillers a test's notes are written around: each listed one, then `RUNS` seeded ones. */
const fillers = (): (Filler | null)[] => [
  ...EVERY_FILLER,
  ...Array.from({ length: RUNS }, () => null),
];

function seededFiller(): string {
  return Array.from({ length: count(3) }, () => {
    const at = Math.floor(random() * FILLER.length);
    saw(`filler ${at}`);
    return FILLER[at]!();
  }).join('\n');
}

/**
 * A literature note DFAI wrote, then edited by hand: lazy lines, removals,
 * Windows endings. Around `given`, or a seeded filler when it is null.
 */
function generatedNote(given: Filler | null = null): string {
  given?.shapes.forEach(saw);
  const filler = given === null ? seededFiller() : given.text;
  const asked = 1 + count(4);
  saw(`${asked} highlights appended`);
  let text = refusedOr(
    `---\ntype: literature\nkind: pdf\ntitle: "Generated"\n---\n${filler}`,
    (note) =>
      appendHighlights({
        text: note,
        highlights: Array.from({ length: asked }, newHighlight),
        random,
        noteBlocks,
      }).text,
  );
  const blocks = readHighlights(text, noteBlocks);
  // Never down to none: the property is about the highlights a note holds.
  if (blocks.length === 0) return generatedNote(given);
  const removed = blocks.length > 1 && random() < 0.3 ? pick(blocks) : null;
  if (removed !== null) {
    text = refusedOr(text, (note) => withoutHighlight({ text: note, id: removed.id, noteBlocks }));
  }
  saw(`one removed ${removed !== null}`);
  const lazy = random() < 0.4;
  if (lazy) text = lazyComments(text);
  saw(`lazy ${lazy}`);
  const windows = random() < 0.3;
  if (windows) text = text.replace(/\n/g, '\r\n');
  saw(`windows ${windows}`);
  return text;
}

/**
 * `write(text)`, or `text` when the write is refused by its own postcondition:
 * a quote whose `%%` would hide the highlights after it (ADR-0043 §5).
 */
function refusedOr(text: string, write: (text: string) => string): string {
  try {
    return write(text);
  } catch (error) {
    if (error instanceof HighlightNotReadBackError) return text;
    throw error;
  }
}

/**
 * Comment lines with their `>` taken off, as Obsidian may leave them: a lazy
 * line, which only a line of words straight after another line of words is.
 */
const lazyComments = (text: string): string =>
  readHighlights(text, noteBlocks)
    .reverse()
    .reduce(
      (note, block) =>
        note.slice(0, block.markerEnd) +
        lazyLines(note.slice(block.markerEnd, block.quoteEnd)) +
        note.slice(block.quoteEnd),
      text,
    );

function lazyLines(comment: string): string {
  const lines = comment.split('\n');
  return lines
    .map((line, at) => {
      const before = lines[at - 1] ?? '>';
      const words = /^> [a-z]/;
      return words.test(line) && words.test(before) ? line.slice(2) : line;
    })
    .join('\n');
}

function savedUnedited(text: string): string {
  const { body } = splitFrontmatter(text);
  const parsed = remarkMarkdown.parseBody(body);
  return (
    text.slice(0, text.length - body.length) +
    remarkMarkdown.serializeBody({ originalBody: body, parsed, doc: parsed.doc })
  );
}

/** Each highlight the editor draws, by id, in the note's order. */
function drawn(text: string): Map<string, HighlightView> {
  const { frontmatter, body } = splitFrontmatter(text);
  const properties = remarkMarkdown.frontmatterProperties(frontmatter);
  const reader = literatureHighlightReader(remarkMarkdown, { properties, text });
  const views = new Map<string, HighlightView>();
  for (const node of remarkMarkdown.parseBody(body).doc.content) {
    const id = node.attrs?.[BLOCK_ANCHOR_ATTR];
    if (node.type !== 'rawBlock' || typeof id !== 'string') continue;
    const view = reader?.({ markdown: String(node.attrs?.['markdown'] ?? ''), id }) ?? null;
    if (view !== null) views.set(id, view);
  }
  return views;
}

function expectDrawnAsRead(text: string) {
  const read = readHighlights(text, noteBlocks);
  const views = drawn(text);
  expect([...views.keys()]).toEqual(read.map((block) => block.id));
  for (const block of read) expect(views.get(block.id)?.comment).toBe(block.comment);
}

/** Where a highlight stands among a note's, which decides what is either side of its comment. */
function placeOf(at: number, of: number): string {
  if (of === 1) return 'the only highlight';
  if (at === 0) return 'the first highlight';
  return at === of - 1 ? 'the last highlight' : 'a highlight between others';
}

const wordsIn = (where: string) => [
  ...WORDS.map((word) => `${where} has ${word}`),
  ...SEPARATORS.map((separator) => `${where} joined by ${JSON.stringify(separator)}`),
];

/** Every shape a generated note holds that the property turns on. */
const EVERY_NOTE_SHAPE = [
  ...FILLER.map((_, at) => `filler ${at}`),
  ...INLINE.map((inline) => `prose with ${inline}`),
  ...[1, 2, 3, 4, 5].map((asked) => `${asked} highlights appended`),
  ...['pdf', 'epub', 'kindle', 'area'].map((kind) => `${kind} anchor`),
  ...['highlight', 'underline'].flatMap((mark) =>
    HIGHLIGHT_COLORS.map((color) => `${mark} in ${color}`),
  ),
  ...wordsIn('quote'),
  ...wordsIn('comment'),
  ...[true, false].flatMap((yes) =>
    ['commented', 'one removed', 'lazy', 'windows'].map((shape) => `${shape} ${yes}`),
  ),
];

/** Every shape a comment typed in place turns on, beyond the note's own. */
const EVERY_EDIT_SHAPE = [
  ...wordsIn('typed'),
  'typed nothing',
  'the only highlight',
  'the first highlight',
  'a highlight between others',
  'the last highlight',
];

const missing = (shapes: readonly string[], drawn: ReadonlySet<string>) =>
  shapes.filter((shape) => !drawn.has(shape));

describe('generated literature notes in the editor', () => {
  it('are drawn as their highlights and saved unedited byte for byte', () => {
    const shapes = drawing();
    for (const filler of fillers()) {
      const text = generatedNote(filler);
      expect(savedUnedited(text)).toBe(text);
      expectDrawnAsRead(text);
    }
    expect(missing(EVERY_NOTE_SHAPE, shapes)).toEqual([]);
  });

  it("change only a comment's bytes when it is typed in place", () => {
    const shapes = drawing();
    let edited = 0;
    const notes = fillers();
    for (const [at, filler] of notes.entries()) {
      const text = generatedNote(filler);
      const blocks = readHighlights(text, noteBlocks);
      const target = pick(blocks);
      saw(placeOf(blocks.indexOf(target), blocks.length));
      const comment = typedFor(at);
      let changed: string;
      try {
        changed = withHighlightComment({ text, id: target.id, comment, noteBlocks });
      } catch (error) {
        // The write's own postcondition: a comment that would hide the rest is refused, unwritten.
        expect(error).toBeInstanceOf(HighlightNotReadBackError);
        continue;
      }
      edited += 1;
      expect(changed.slice(0, target.markerEnd)).toBe(text.slice(0, target.markerEnd));
      expect(changed.endsWith(text.slice(target.quoteEnd))).toBe(true);
      expect(savedUnedited(changed)).toBe(changed);
      expectDrawnAsRead(changed);
      expect(drawn(changed).get(target.id)?.comment).toBe(commentLines(comment).join('\n'));
    }
    // Most runs write: the property is about edits, not refusals.
    expect(edited).toBeGreaterThan(notes.length * 0.8);
    expect(missing([...EVERY_NOTE_SHAPE, ...EVERY_EDIT_SHAPE], shapes)).toEqual([]);
  });
});
