import { describe, expect, it } from 'vitest';
import {
  type HighlightAnchor,
  type HighlightStyle,
  HIGHLIGHT_COLORS,
  appendHighlights,
  highlightNamed,
  withHighlightComment,
  withoutHighlight,
  type NewHighlight,
  readHighlights,
  type HighlightBlock,
  commentLines,
  plainQuote,
  quoteLines,
} from '@dfai/domain';
import { noteBlocks } from './note-blocks.ts';

/**
 * Property (#503): whatever a literature note holds around its highlights, and
 * however the person edited their quotes and comments in Obsidian, every
 * write changes only the highlight it is about. The others read back the
 * same and keep their bytes; the words between them keep theirs; a comment
 * written back as it reads is the same bytes; ids are Obsidian's six
 * characters, drawn from the seeded source and never repeated.
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

// HIGHLIGHT_PROPERTY_SEED and HIGHLIGHT_PROPERTY_RUNS run other notes, and more, by hand.
const random = seeded(Number(process.env['HIGHLIGHT_PROPERTY_SEED'] ?? 20261021));
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const count = (max: number) => Math.floor(random() * (max + 1));

const WORDS = [
  'warfare',
  'deception',
  '*bold*',
  '#tag',
  '==mark==',
  '%%hide%%',
  '[[Moby Dick]]',
  '<b>',
  '-->',
  '<!--',
  'a|b',
  '`code`',
  '^abc123',
  '\\',
  '$x$',
  '&amp;',
  'é',
  '—',
  '1.',
  '-',
  '>',
];

/** What the notes drawn so far hold that the property turns on. */
let seen = new Set<string>();
const saw = (shape: string) => seen.add(shape);

/** Starts a test's record of what its notes hold. */
function drawing(): Set<string> {
  seen = new Set();
  return seen;
}

const SEPARATORS = [' ', '  ', '\n', ' \n '];

/** Words for a quote, a comment, an anchor, prose, or a comment written back (`where`). */
function words(max: number, where: string): string {
  const drawn = Array.from({ length: 1 + count(max) }, () => pick(WORDS));
  const separator = pick(SEPARATORS);
  for (const word of drawn) saw(`${where} has ${word}`);
  if (drawn.length > 1) saw(`${where} joined by ${JSON.stringify(separator)}`);
  return drawn.join(separator);
}

const ANCHORS: (() => HighlightAnchor)[] = [
  () => {
    const page = 1 + count(400);
    const quote = {
      exact: words(6, 'anchor'),
      prefix: words(3, 'anchor'),
      suffix: words(3, 'anchor'),
    };
    const rects = Array.from({ length: count(3) }, () => ({
      x: random() * 0.5,
      y: random() * 0.5,
      width: 0.1 + random() * 0.4,
      height: 0.01 + random() * 0.1,
    }));
    saw(`pdf quote in ${rects.length} rects`);
    return { kind: 'pdf', page, quote, rects };
  },
  () => {
    saw('pdf area');
    return {
      kind: 'pdf',
      page: 1 + count(9),
      quote: null,
      rects: [{ x: 0, y: random() * 0.5, width: 1, height: 0.25 }],
    };
  },
  () => {
    saw('epub');
    return {
      kind: 'epub',
      cfi: `epubcfi(/6/${2 * (1 + count(40))}!/4/2/1:${count(300)})`,
      quote: { exact: words(6, 'anchor'), prefix: '', suffix: words(2, 'anchor') },
    };
  },
  () => {
    const start = 1 + count(9000);
    const end = random() < 0.5 ? null : 9001 + count(10);
    const annotationId = random() < 0.5 ? null : `AMZ-${count(1e6)}`;
    saw(`kindle ending ${end !== null}, with an id ${annotationId !== null}`);
    return { kind: 'kindle', location: { start, end }, annotationId };
  },
];

function style(): HighlightStyle {
  const drawn = { mark: pick(['highlight', 'underline'] as const), color: pick(HIGHLIGHT_COLORS) };
  saw(`${drawn.mark} in ${drawn.color}`);
  return drawn;
}

const TOMBSTONE_LINE = '<!-- atlas:highlight-removed [^\\n]*-->\\n';

/**
 * The note without each tombstone line and the one blank line written before
 * it, as its highlight was appended — or none, for one appended first in an
 * empty body, right after the frontmatter. No other blank line is folded, so
 * one lost anywhere else still shows.
 */
const withoutTombstones = (text: string): string =>
  text
    .replace(new RegExp(`^\\n${TOMBSTONE_LINE}`, 'gm'), '')
    .replace(new RegExp(`^(---\\n[\\s\\S]*?\\n---\\n)${TOMBSTONE_LINE}`), '$1');

function newHighlight(): NewHighlight {
  const quote = words(12, 'quote');
  const anchor = pick(ANCHORS)();
  const drawn = style();
  const commented = random() < 0.6;
  saw(`commented ${commented}`);
  return {
    quote,
    anchor,
    style: drawn,
    ...(commented && { comment: words(8, 'comment').replace(/^>|\n>/g, ' ') }),
  };
}

/** One to five highlights to append. */
function newHighlights(): NewHighlight[] {
  const asked = 1 + count(4);
  saw(`${asked} highlights appended`);
  return Array.from({ length: asked }, newHighlight);
}

/** What a note holds around highlights: prose, a plain quote, a fence with a look-alike, a list. */
const FILLER = [
  // Prose never opens with `<!--`: a line that does is an HTML comment block, which hides the rest if unclosed.
  () => `Prose: ${words(10, 'prose').replace(/\n/g, ' ')}\n`,
  () => '> A plain quote, no marker.\n',
  () =>
    '```\n> Not a highlight.\n> <!-- atlas:highlight {"v":1,"kind":"kindle","location":3} -->\n\n^fake01\n```\n',
  () => '- a list item ^li0001\n',
  () => '## A heading\n',
];

function literatureNote(): string {
  const body = Array.from({ length: count(4) }, () => {
    const at = Math.floor(random() * FILLER.length);
    saw(`filler ${at}`);
    return FILLER[at]!();
  }).join('\n');
  return `---\ntype: literature\nkind: pdf\ntitle: "Generated"\n---\n${body}`;
}

/** Edits a person makes in Obsidian: tidy a quote line, add a line to a comment, words between blocks. */
function editedByHand(text: string): string {
  const blocks = readHighlights(text, noteBlocks);
  let edited = text;
  for (const block of [...blocks].reverse()) {
    const choice = count(3);
    saw(`hand edit ${choice}`);
    if (choice === 0) edited = splice(edited, block.start, block.start + 1, '>  ');
    if (choice === 1)
      edited = splice(edited, block.quoteEnd, block.quoteEnd, '>\n> Added in Obsidian.\n');
    if (choice === 2) edited = splice(edited, block.end, block.end, '\nWritten between.\n');
  }
  return edited;
}

const splice = (text: string, start: number, end: number, insert: string) =>
  text.slice(0, start) + insert + text.slice(end);

const model = ({ id, quote, comment, style: drawn, anchor }: HighlightBlock) => ({
  id,
  quote,
  comment,
  style: drawn,
  anchor,
});

const bytesOf = (text: string, block: HighlightBlock) => text.slice(block.start, block.end);

function expectOthersKept(before: string, after: string, except: string | null) {
  const kept = readHighlights(before, noteBlocks).filter((block) => block.id !== except);
  const now = new Map(readHighlights(after, noteBlocks).map((block) => [block.id, block]));
  for (const block of kept) {
    const read = now.get(block.id);
    expect(read && model(read)).toEqual(model(block));
    expect(read && bytesOf(after, read)).toBe(bytesOf(before, block));
  }
}

/**
 * Each run parses the note a few times over, so a run takes milliseconds, and
 * 300 a test timed out under load (#854). Each test shows below that its runs
 * drew every shape the property turns on.
 */
const RUNS = Number(process.env['HIGHLIGHT_PROPERTY_RUNS'] ?? 60);

/** Where a highlight stands among a note's, which decides what is either side of it. */
function placeOf(at: number, of: number): string {
  if (of === 1) return 'the only highlight';
  if (at === 0) return 'the first highlight';
  return at === of - 1 ? 'the last highlight' : 'a highlight between others';
}

/** A highlight of the note's to write to, by where it stands. */
function targetIn(text: string): HighlightBlock {
  const blocks = readHighlights(text, noteBlocks);
  const target = pick(blocks);
  saw(placeOf(blocks.indexOf(target), blocks.length));
  return target;
}

const wordsIn = (where: string) => [
  ...WORDS.map((word) => `${where} has ${word}`),
  ...SEPARATORS.map((separator) => `${where} joined by ${JSON.stringify(separator)}`),
];

/** Every shape a note and the highlights appended to it hold that the property turns on. */
const EVERY_NOTE_SHAPE = [
  ...FILLER.map((_, at) => `filler ${at}`),
  ...[1, 2, 3, 4, 5].map((asked) => `${asked} highlights appended`),
  ...[0, 1, 2, 3].map((rects) => `pdf quote in ${rects} rects`),
  'pdf area',
  'epub',
  ...[true, false].flatMap((ending) =>
    [true, false].map((id) => `kindle ending ${ending}, with an id ${id}`),
  ),
  ...['highlight', 'underline'].flatMap((mark) =>
    HIGHLIGHT_COLORS.map((color) => `${mark} in ${color}`),
  ),
  'commented true',
  'commented false',
  ...['quote', 'comment', 'anchor', 'prose'].flatMap(wordsIn),
];

/** Every edit by hand, each a person makes in Obsidian. */
const EVERY_HAND_EDIT = [0, 1, 2, 3].map((choice) => `hand edit ${choice}`);

/** Every place the highlight written to can stand. */
const EVERY_PLACE = [
  'the only highlight',
  'the first highlight',
  'a highlight between others',
  'the last highlight',
];

const missing = (shapes: readonly string[], drawn: ReadonlySet<string>) =>
  shapes.filter((shape) => !drawn.has(shape));

describe('literature notes under any edits', () => {
  it('reads back every highlight appended, with fresh ids, and writes only after the last byte', () => {
    const shapes = drawing();
    for (let run = 0; run < RUNS; run += 1) {
      const before = literatureNote();
      const added = newHighlights();
      const { text, highlights } = appendHighlights({
        text: before,
        highlights: added,
        random,
        noteBlocks,
      });
      expect(text.startsWith(before)).toBe(true);
      const fresh = highlights
        .filter((highlight) => highlight.added)
        .map((highlight) => highlight.id);
      expect(new Set(fresh).size).toBe(fresh.length);
      for (const id of fresh) expect(id).toMatch(/^[a-z0-9]{6}$/);
      expect(fresh).not.toContain('li0001');
      for (const [index, highlight] of added.entries()) {
        const answered = highlights[index];
        if (answered?.added !== true) continue;
        const block = highlightNamed(text, answered.id, noteBlocks);
        expect(plainQuote(block.quote)).toBe(
          quoteLines(highlight.quote).map(plainQuote).join('\n\n'),
        );
        // A Kindle anchor keeps the export's words (R3).
        const written =
          highlight.anchor.kind === 'kindle'
            ? { ...highlight.anchor, exact: highlight.quote }
            : highlight.anchor;
        expect(block.anchor).toEqual(written);
        expect(block.comment).toBe(commentLines(highlight.comment ?? '').join('\n'));
        expect(block.style).toEqual(highlight.style);
      }
      expect(readHighlights(before, noteBlocks)).toEqual([]);
    }
    expect(missing([...EVERY_NOTE_SHAPE], shapes)).toEqual([]);
  });

  it('changes only the comment it is given, keeping hand edits everywhere', () => {
    const shapes = drawing();
    for (let run = 0; run < RUNS; run += 1) {
      const { text: written } = appendHighlights({
        text: literatureNote(),
        highlights: newHighlights(),
        random,
        noteBlocks,
      });
      const text = editedByHand(written);
      const target = targetIn(text);
      const typedNothing = random() < 0.2;
      if (typedNothing) saw('typed nothing');
      const comment = typedNothing ? '' : words(6, 'typed').replace(/^>|\n>/g, ' ');
      const changed = withHighlightComment({ text, id: target.id, comment, noteBlocks });
      expect(highlightNamed(changed, target.id, noteBlocks).comment).toBe(
        commentLines(comment).join('\n'),
      );
      expect(highlightNamed(changed, target.id, noteBlocks).quote).toBe(target.quote);
      expect(changed.slice(0, target.markerEnd)).toBe(text.slice(0, target.markerEnd));
      expect(changed.endsWith(text.slice(target.quoteEnd))).toBe(true);
      expectOthersKept(text, changed, target.id);
    }
    expect(
      missing(
        [
          ...EVERY_NOTE_SHAPE,
          ...EVERY_HAND_EDIT,
          ...EVERY_PLACE,
          'typed nothing',
          ...wordsIn('typed'),
        ],
        shapes,
      ),
    ).toEqual([]);
  });

  it('writes back the same bytes for every comment as it reads', () => {
    const shapes = drawing();
    for (let run = 0; run < RUNS; run += 1) {
      const { text: written } = appendHighlights({
        text: literatureNote(),
        highlights: newHighlights(),
        random,
        noteBlocks,
      });
      const text = editedByHand(written);
      for (const block of readHighlights(text, noteBlocks)) {
        expect(
          withHighlightComment({ text, id: block.id, comment: block.comment, noteBlocks }),
        ).toBe(text);
      }
    }
    expect(missing([...EVERY_NOTE_SHAPE, ...EVERY_HAND_EDIT], shapes)).toEqual([]);
  });

  it('removes only the highlight it is given, and removing all it added gives the note back', () => {
    const shapes = drawing();
    for (let run = 0; run < RUNS; run += 1) {
      const before = `${literatureNote().trimEnd()}\n`;
      const { text: written, highlights } = appendHighlights({
        text: before,
        highlights: newHighlights(),
        random,
        noteBlocks,
      });
      const text = editedByHand(written);
      const target = targetIn(text);
      const removed = withoutHighlight({ text, id: target.id, noteBlocks });
      expect(readHighlights(removed, noteBlocks).map((block) => block.id)).not.toContain(target.id);
      expectOthersKept(text, removed, target.id);
      let emptied = written;
      for (const { id } of [...highlights].reverse()) {
        if (readHighlights(emptied, noteBlocks).some((block) => block.id === id))
          emptied = withoutHighlight({ text: emptied, id, noteBlocks });
      }
      // A Kindle highlight leaves its tombstone where it was (ADR-0043 §5): all else comes back.
      expect(withoutTombstones(emptied)).toBe(before);
    }
    expect(missing([...EVERY_NOTE_SHAPE, ...EVERY_HAND_EDIT, ...EVERY_PLACE], shapes)).toEqual([]);
  });
});
