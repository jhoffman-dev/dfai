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
  type HighlightBlock,
  type HighlightStyle,
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

// HIGHLIGHT_EDITOR_SEED and HIGHLIGHT_EDITOR_RUNS run other notes, and more, by hand (with
// vitest's --testTimeout raised for many: the 5 s default suits these runs).
const SEED = Number(process.env['HIGHLIGHT_EDITOR_SEED'] ?? 20261023);
/** The test's own seeded source (see `drawing`), so no test's draws depend on another's. */
let random = seeded(SEED);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const count = (max: number) => Math.floor(random() * (max + 1));
// Each note costs about 30 ms to write, save and draw (ten times that under
// coverage in CI), so 200 a test timed out under load (#854). Listed notes
// and comments (`UNEDITED`, `TYPED_INTO`, `EVERY_TYPED`) draw the rare shapes
// and pairs, and each test shows below that its notes drew every one.
const RUNS = Number(process.env['HIGHLIGHT_EDITOR_RUNS'] ?? 6);

/** What the test's notes hold that the property turns on. */
let seen = new Set<string>();
const saw = (shape: string) => seen.add(shape);

/** Starts test `n`: its own seeded source, and its own record of what its notes hold. */
function drawing(n: number): Set<string> {
  random = seeded(SEED + n);
  seen = new Set();
  return seen;
}

/** Runs `draw` with the shapes it records held back, for `keep` to record once they count. */
function heldBack<T>(draw: () => T): { value: T; keep: () => void } {
  const outer = seen;
  seen = new Set();
  const value = draw();
  const held = seen;
  seen = outer;
  return { value, keep: () => held.forEach(saw) };
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

/**
 * Two lines a lazy line can be made of (`lazyLines` folds only a line of
 * lowercase words after another): seeded comments hold one such word in 18,
 * so they all but never have two such lines.
 */
const LAZY_TAIL = '\nwarfare\nwarfare';

const MARKS = ['highlight', 'underline'] as const;
/** Every mark in every colour. */
const STYLES: readonly HighlightStyle[] = MARKS.flatMap((mark) =>
  HIGHLIGHT_COLORS.map((color) => ({ mark, color })),
);

/**
 * A new highlight in `style`, or a drawn one; with `lazyTail`, its comment
 * ends in lines that can be made lazy.
 */
function newHighlight({
  lazyTail = false,
  style: listed,
}: { lazyTail?: boolean; style?: HighlightStyle } = {}): NewHighlight {
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
  const style = listed ?? { mark: pick(MARKS), color: pick(HIGHLIGHT_COLORS) };
  saw(`${style.mark} in ${style.color}`);
  const commented = lazyTail || random() < 0.7;
  saw(`commented ${commented}`);
  return {
    quote,
    ...(image !== null && { image }),
    anchor,
    style,
    ...(commented && { comment: `${words(6, 'comment')}${lazyTail ? LAZY_TAIL : ''}` }),
  };
}

const INLINE = ['*bold*', '#tag', '%%aside%%', '[[Larkspur Payroll]]', '^abc123'];

// Prose never leaves a `%%` open: an append after one is refused (ADR-0043 §5), and nothing is drawn.
const prose = (inline: string) => `Prose with ${inline} in it.\n`;

const FILLER: readonly { name: string; write: () => string }[] = [
  {
    name: 'prose',
    write: () => {
      const inline = pick(INLINE);
      saw(`prose with ${inline}`);
      return prose(inline);
    },
  },
  { name: 'plain quote', write: () => '> A plain quote, no marker.\n' },
  { name: 'list item', write: () => '- a list item ^li0001\n' },
  { name: 'heading', write: () => '## A heading\n' },
  { name: 'hidden aside', write: () => '%%\nA hidden aside.\n%%\n' },
  { name: 'table', write: () => '| a | b |\n| - | - |\n| 1 | 2 |\n' },
];

/** What stands before a note's highlights, or a comment typed, and the shapes it holds. */
interface Listed {
  readonly text: string;
  readonly shapes: readonly string[];
}

/**
 * Every filler there is in two: prose with each of its inlines, and each
 * other filler. One in 30 fillers is a given prose, which seeded notes would
 * take a hundred or more to draw.
 */
const [EVERY_PROSE, EVERY_OTHER_FILLER] = [
  {
    text: INLINE.map(prose).join('\n'),
    shapes: ['filler prose', ...INLINE.map((inline) => `prose with ${inline}`)],
  },
  {
    text: FILLER.slice(1)
      .map(({ write }) => write())
      .join('\n'),
    shapes: FILLER.slice(1).map(({ name }) => `filler ${name}`),
  },
] as const satisfies readonly Listed[];

/** Comments holding every word, one joined by each separator: what the first edits type. */
const EVERY_TYPED: readonly Listed[] = SEPARATORS.map((separator) => ({
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

const BOTH = [true, false];

type Place = 'only' | 'first' | 'between' | 'last';

/** Where a highlight stands among a note's, which decides what is either side of its comment. */
function placeOf(at: number, of: number): Place {
  if (of === 1) return 'only';
  if (at === 0) return 'first';
  return at === of - 1 ? 'last' : 'between';
}

/**
 * A note a test lists rather than draws, for the pairs seeded notes are slow
 * to meet. Each part it leaves out is drawn; `place` is the highlight typed into.
 */
interface Recipe {
  readonly filler?: Listed;
  readonly asked?: number;
  readonly removeOne?: boolean;
  readonly lazy?: boolean;
  readonly windows?: boolean;
  readonly place?: Place;
  /** The styles of the highlights appended, as many as there are. */
  readonly styles?: readonly HighlightStyle[];
}

/** Each pair of lazy lines and Windows endings, around every filler: the unedited notes listed. */
const UNEDITED: readonly Recipe[] = [
  { filler: EVERY_PROSE, lazy: true, windows: true },
  { filler: EVERY_OTHER_FILLER, lazy: true, windows: false },
  { lazy: false, windows: true },
  { lazy: false, windows: false },
  // Every mark in every colour over 1, 2, 4 and 5 highlights: pairs and counts seeded notes are slow to meet.
].map((recipe, at) => ({ ...recipe, styles: STYLES.slice([0, 1, 3, 7][at], [1, 3, 7, 12][at]) }));

/**
 * A comment typed into the first and the last highlight under each pair of
 * lazy lines and Windows endings, with another highlight removed; and into
 * the only one and one between others, with lazy lines and without.
 */
const TYPED_INTO: readonly Recipe[] = [
  ...(['first', 'last'] as const).flatMap((place) =>
    BOTH.flatMap((lazy) =>
      BOTH.map((windows) => ({ place, lazy, windows, asked: 4, removeOne: true })),
    ),
  ),
  ...BOTH.flatMap((lazy) => [
    { place: 'between' as const, lazy, asked: 3, removeOne: false },
    { place: 'only' as const, lazy, asked: 1, removeOne: false },
  ]),
].map((recipe, at) => {
  // The first two are written around every filler there is, as the unedited ones are.
  const filler = [EVERY_PROSE, EVERY_OTHER_FILLER][at];
  return filler === undefined ? recipe : { ...recipe, filler };
});

/** A test's notes: the listed ones, then `RUNS` seeded ones. */
const notesOf = (listed: readonly Recipe[]): Recipe[] => [
  ...listed,
  ...Array.from({ length: RUNS }, () => ({})),
];

function seededFiller(): string {
  return Array.from({ length: count(3) }, () => {
    const { name, write } = pick(FILLER);
    saw(`filler ${name}`);
    return write();
  }).join('\n');
}

/** A generated note, with what was done to it by hand. */
interface Note {
  readonly text: string;
  readonly removed: boolean;
  readonly lazy: boolean;
  readonly windows: boolean;
}

/**
 * A literature note DFAI wrote, then edited by hand: lazy lines, removals,
 * Windows endings, as `recipe` lists them or drawn where it does not. Drawn
 * again until it holds what the recipe lists, highlights to fit its `place`
 * among them.
 */
function generatedNote(recipe: Recipe = {}): Note {
  for (let tries = 0; tries < 100; tries += 1) {
    const { value: note, keep } = heldBack(() => drawnNote(recipe));
    const placed = readHighlights(note.text, noteBlocks).length;
    const fits =
      (recipe.removeOne === undefined || recipe.removeOne === note.removed) &&
      (recipe.lazy === undefined || recipe.lazy === note.lazy) &&
      (recipe.place === undefined || (recipe.place === 'only') === (placed === 1)) &&
      (recipe.place !== 'between' || placed >= 3);
    if (!fits) continue;
    keep();
    return note;
  }
  throw new Error(`no note drawn in 100 tries holds ${JSON.stringify(recipe)}`);
}

function drawnNote(recipe: Recipe): Note {
  if (recipe.filler !== undefined) recipe.filler.shapes.forEach(saw);
  const filler = recipe.filler?.text ?? seededFiller();
  const asked = recipe.styles?.length ?? recipe.asked ?? 1 + count(4);
  saw(`${asked} highlights appended`);
  let text = refusedOr(
    `---\ntype: literature\nkind: pdf\ntitle: "Generated"\n---\n${filler}`,
    (note) =>
      appendHighlights({
        text: note,
        highlights: Array.from({ length: asked }, (_, at) =>
          newHighlight({
            lazyTail: recipe.lazy === true,
            ...(recipe.styles?.[at] !== undefined && { style: recipe.styles[at] }),
          }),
        ),
        random,
        noteBlocks,
      }).text,
  );
  const blocks = readHighlights(text, noteBlocks);
  // Never down to none: the property is about the highlights a note holds.
  if (blocks.length === 0) return drawnNote(recipe);
  const removeOne = blocks.length > 1 && (recipe.removeOne ?? random() < 0.3);
  const unremoved = text;
  if (removeOne) {
    const { id } = pick(blocks);
    text = refusedOr(text, (note) => withoutHighlight({ text: note, id, noteBlocks }));
  }
  const removed = text !== unremoved;
  saw(`one removed ${removed}`);
  // Lazy only where a comment has a line a lazy line can be: what counts is that one was made.
  const lazy = (recipe.lazy ?? random() < 0.4) && lazyComments(text) !== text;
  if (lazy) text = lazyComments(text);
  saw(`lazy ${lazy}`);
  const windows = recipe.windows ?? random() < 0.3;
  if (windows) text = text.replace(/\n/g, '\r\n');
  saw(`windows ${windows}`);
  saw(`lazy ${lazy}, windows ${windows}`);
  return { text, removed, lazy, windows };
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

const wordsIn = (where: string) => [
  ...WORDS.map((word) => `${where} has ${word}`),
  ...SEPARATORS.map((separator) => `${where} joined by ${JSON.stringify(separator)}`),
];

const PLACES: readonly Place[] = ['only', 'first', 'between', 'last'];

/** Every shape a generated note holds that the property turns on. */
const EVERY_NOTE_SHAPE = [
  ...FILLER.map(({ name }) => `filler ${name}`),
  ...INLINE.map((inline) => `prose with ${inline}`),
  ...[1, 2, 3, 4, 5].map((asked) => `${asked} highlights appended`),
  ...['pdf', 'epub', 'kindle', 'area'].map((kind) => `${kind} anchor`),
  ...STYLES.map(({ mark, color }) => `${mark} in ${color}`),
  ...wordsIn('quote'),
  ...wordsIn('comment'),
  ...BOTH.flatMap((yes) =>
    ['commented', 'one removed', 'lazy', 'windows'].map((shape) => `${shape} ${yes}`),
  ),
  ...BOTH.flatMap((lazy) => BOTH.map((windows) => `lazy ${lazy}, windows ${windows}`)),
];

/** Every shape a comment typed in place turns on, beyond the note's own. */
const EVERY_EDIT_SHAPE = [
  ...wordsIn('typed'),
  'typed nothing',
  ...PLACES.flatMap((place) => BOTH.map((lazy) => `typed into ${place}, lazy ${lazy}`)),
  ...(['first', 'last'] as const).flatMap((place) =>
    BOTH.flatMap((lazy) =>
      BOTH.map((windows) => `typed into ${place}, lazy ${lazy}, windows ${windows}, one removed`),
    ),
  ),
];

const missing = (shapes: readonly string[], drawn: ReadonlySet<string>) =>
  shapes.filter((shape) => !drawn.has(shape));

/** The highlight to type into: the one at `place` when it is listed, else any. */
function targetAt(blocks: readonly HighlightBlock[], place: Place | undefined): HighlightBlock {
  if (place === undefined) return pick(blocks);
  if (place === 'last') return blocks[blocks.length - 1]!;
  if (place === 'between') return blocks[1 + Math.floor(random() * (blocks.length - 2))]!;
  return blocks[0]!;
}

describe('generated literature notes in the editor', () => {
  it('are drawn as their highlights and saved unedited byte for byte', () => {
    const shapes = drawing(0);
    for (const recipe of notesOf(UNEDITED)) {
      const { text } = generatedNote(recipe);
      expect(savedUnedited(text)).toBe(text);
      expectDrawnAsRead(text);
    }
    expect(missing(EVERY_NOTE_SHAPE, shapes)).toEqual([]);
  });

  it("change only a comment's bytes when it is typed in place", () => {
    const shapes = drawing(1);
    let edited = 0;
    const notes = notesOf(TYPED_INTO);
    for (const [at, recipe] of notes.entries()) {
      const note = generatedNote(recipe);
      const { text } = note;
      const blocks = readHighlights(text, noteBlocks);
      const target = targetAt(blocks, recipe.place);
      const place = placeOf(blocks.indexOf(target), blocks.length);
      // What the edit types counts only once it is written: a refused one proves nothing.
      const { value: comment, keep } = heldBack(() => typedFor(at));
      let changed: string;
      try {
        changed = withHighlightComment({ text, id: target.id, comment, noteBlocks });
      } catch (error) {
        // The write's own postcondition: a comment that would hide the rest is refused, unwritten.
        expect(error).toBeInstanceOf(HighlightNotReadBackError);
        continue;
      }
      edited += 1;
      keep();
      saw(`typed into ${place}, lazy ${note.lazy}`);
      if (note.removed) {
        saw(`typed into ${place}, lazy ${note.lazy}, windows ${note.windows}, one removed`);
      }
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
