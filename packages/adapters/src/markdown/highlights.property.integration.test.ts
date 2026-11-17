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

// HIGHLIGHT_PROPERTY_SEED and HIGHLIGHT_PROPERTY_RUNS run other notes, and more, by hand (with
// vitest's --testTimeout raised for many: the 5 s default suits these runs).
const SEED = Number(process.env['HIGHLIGHT_PROPERTY_SEED'] ?? 20261021);
/** The test's own seeded source (see `drawing`), so no test's draws depend on another's. */
let random = seeded(SEED);
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

/** What the test's notes hold that the property turns on. */
let seen = new Set<string>();
const saw = (shape: string) => seen.add(shape);

/** Starts test `n`: its own seeded source, and its own record of what its notes hold. */
function drawing(n: number): Set<string> {
  random = seeded(SEED + n);
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

/** A PDF anchor on a quote, over `rects` rectangles (none to three). */
function pdfQuote(rects: number): HighlightAnchor {
  saw(`pdf quote in ${rects} rects`);
  return {
    kind: 'pdf',
    page: 1 + count(400),
    quote: { exact: words(6, 'anchor'), prefix: words(3, 'anchor'), suffix: words(3, 'anchor') },
    rects: Array.from({ length: rects }, () => ({
      x: random() * 0.5,
      y: random() * 0.5,
      width: 0.1 + random() * 0.4,
      height: 0.01 + random() * 0.1,
    })),
  };
}

function pdfArea(): HighlightAnchor {
  saw('pdf area');
  return {
    kind: 'pdf',
    page: 1 + count(9),
    quote: null,
    rects: [{ x: 0, y: random() * 0.5, width: 1, height: 0.25 }],
  };
}

function epub(): HighlightAnchor {
  saw('epub');
  return {
    kind: 'epub',
    cfi: `epubcfi(/6/${2 * (1 + count(40))}!/4/2/1:${count(300)})`,
    quote: { exact: words(6, 'anchor'), prefix: '', suffix: words(2, 'anchor') },
  };
}

/** A Kindle anchor, with an end location or not, and an annotation id or not. */
function kindle(ending: boolean, withId: boolean): HighlightAnchor {
  saw(`kindle ending ${ending}, with an id ${withId}`);
  return {
    kind: 'kindle',
    location: { start: 1 + count(9000), end: ending ? 9001 + count(10) : null },
    annotationId: withId ? `AMZ-${count(1e6)}` : null,
  };
}

/** Each kind of anchor, drawn the same: what a seeded highlight is anchored by. */
const ANCHORS: (() => HighlightAnchor)[] = [
  () => pdfQuote(count(3)),
  pdfArea,
  epub,
  () => kindle(random() < 0.5, random() < 0.5),
];

/** Every anchor shape there is: what the listed highlights turn through. */
const EVERY_ANCHOR: (() => HighlightAnchor)[] = [
  ...[0, 1, 2, 3].map((rects) => () => pdfQuote(rects)),
  pdfArea,
  epub,
  ...[true, false].flatMap((ending) => [true, false].map((withId) => () => kindle(ending, withId))),
];

const MARKS = ['highlight', 'underline'] as const;
/** Every mark in every colour. */
const STYLES: readonly HighlightStyle[] = MARKS.flatMap((mark) =>
  HIGHLIGHT_COLORS.map((color) => ({ mark, color })),
);

/** `listed`, or a drawn style. */
function style(listed?: HighlightStyle): HighlightStyle {
  const drawn = listed ?? { mark: pick(MARKS), color: pick(HIGHLIGHT_COLORS) };
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

/** A highlight a note lists: its style, and which of `EVERY_ANCHOR` anchors it. */
interface ListedHighlight {
  readonly style: HighlightStyle;
  readonly anchor: () => HighlightAnchor;
  /** A comment of every word (`EVERY_WORD`), or a drawn one. */
  readonly comment?: { text: string; shapes: (where: string) => string[] };
}

function newHighlight(listed?: ListedHighlight): NewHighlight {
  const quote = words(12, 'quote');
  const anchor = (listed?.anchor ?? pick(ANCHORS))();
  const drawn = style(listed?.style);
  if (listed?.comment !== undefined) listed.comment.shapes('comment').forEach(saw);
  const commented = listed?.comment !== undefined || random() < 0.6;
  saw(`commented ${commented}`);
  const comment = listed?.comment?.text ?? (commented ? words(8, 'comment') : null);
  return {
    quote,
    anchor,
    style: drawn,
    ...(comment !== null && { comment: comment.replace(/^>|\n>/g, ' ') }),
  };
}

/** One to five highlights to append, or the `listed` ones. */
function newHighlights(listed?: readonly ListedHighlight[]): NewHighlight[] {
  const asked = listed?.length ?? 1 + count(4);
  saw(`${asked} highlights appended`);
  return Array.from({ length: asked }, (_, at) => newHighlight(listed?.[at]));
}

/** What a note holds around highlights: prose, a plain quote, a fence with a look-alike, a list. */
const FILLER: readonly { name: string; write: () => string }[] = [
  // Prose never opens with `<!--`: a line that does is an HTML comment block, which hides the rest if unclosed.
  // So its words are kept to one line, and which separator joined them is not a shape of the note.
  { name: 'prose', write: () => `Prose: ${words(10, 'prose').replace(/\n/g, ' ')}\n` },
  { name: 'plain quote', write: () => '> A plain quote, no marker.\n' },
  {
    name: 'fenced look-alike',
    write: () =>
      '```\n> Not a highlight.\n> <!-- atlas:highlight {"v":1,"kind":"kindle","location":3} -->\n\n^fake01\n```\n',
  },
  { name: 'list item', write: () => '- a list item ^li0001\n' },
  { name: 'heading', write: () => '## A heading\n' },
];

/** Every word joined by each separator: what the first notes' prose, listed comments and the first comments typed hold. */
const EVERY_WORD = SEPARATORS.map((separator) => ({
  text: WORDS.join(separator),
  shapes: (where: string) => [
    ...WORDS.map((word) => `${where} has ${word}`),
    `${where} joined by ${JSON.stringify(separator)}`,
  ],
}));

/**
 * The `run`th note: the first ones each a prose of every word, as one in five
 * fillers is prose and seeded notes take dozens to draw each word in one;
 * the next every other filler; then seeded fillers.
 */
function literatureNote(run: number): string {
  return `---\ntype: literature\nkind: pdf\ntitle: "Generated"\n---\n${bodyOf(run)}`;
}

function bodyOf(run: number): string {
  const listed = EVERY_WORD[run];
  if (listed !== undefined) {
    ['filler prose', ...listed.shapes('prose')].forEach(saw);
    return `Prose: ${listed.text.replace(/\n/g, ' ')}\n`;
  }
  // The next note holds every other filler, which seeded notes are slow to draw all of.
  const fillers =
    run === EVERY_WORD.length
      ? FILLER.slice(1)
      : Array.from({ length: count(4) }, () => pick(FILLER));
  return fillers
    .map(({ name, write }) => {
      saw(`filler ${name}`);
      return write();
    })
    .join('\n');
}

/** The comment the `run`th edit types: every word at first, then seeded ones, some of them nothing. */
function typedFor(run: number): string {
  const listed = EVERY_WORD[run];
  if (listed !== undefined) {
    listed.shapes('typed').forEach(saw);
    return listed.text.replace(/^>|\n>/g, ' ');
  }
  const typedNothing = random() < 0.2;
  if (typedNothing) saw('typed nothing');
  return typedNothing ? '' : words(6, 'typed').replace(/^>|\n>/g, ' ');
}

/** Edits a person makes in Obsidian to a highlight, or none. */
const HAND_EDITS = [
  'quote line tidied',
  'comment line added',
  'words written after',
  'none',
] as const;
type HandEdit = (typeof HAND_EDITS)[number];

/**
 * Each highlight edited by hand as a person does in Obsidian: tidy a quote
 * line, add a line to a comment, words between blocks. The one at `listed.at`
 * gets `listed.edit`; each other's is drawn. Returns which edit each got, by id.
 */
function editedByHand(
  text: string,
  listed?: { at: number; edit: HandEdit },
): { text: string; edits: Map<string, HandEdit> } {
  const blocks = readHighlights(text, noteBlocks);
  const edits = new Map<string, HandEdit>();
  let edited = text;
  for (const [at, block] of [...blocks.entries()].reverse()) {
    const edit = listed?.at === at ? listed.edit : HAND_EDITS[count(3)]!;
    edits.set(block.id, edit);
    saw(`hand edit: ${edit}`);
    if (edit === 'quote line tidied') edited = splice(edited, block.start, block.start + 1, '>  ');
    if (edit === 'comment line added')
      edited = splice(edited, block.quoteEnd, block.quoteEnd, '>\n> Added in Obsidian.\n');
    if (edit === 'words written after')
      edited = splice(edited, block.end, block.end, '\nWritten between.\n');
  }
  return { text: edited, edits };
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
 * Each run parses the note a few times over, so a run takes milliseconds (near
 * 100 under coverage in CI), and 300 a test timed out under load (#854). Listed
 * notes come first: every count, style, anchor and word (`EVERY_COUNT`,
 * `EVERY_WORD`), and each place written to with each edit by hand to it
 * (`PLACED_EDITS`). Each test shows below that its notes drew every shape.
 */
const RUNS = Number(process.env['HIGHLIGHT_PROPERTY_RUNS'] ?? 6);

type Place = 'only' | 'first' | 'between' | 'last';
const PLACES: readonly Place[] = ['only', 'first', 'between', 'last'];

/** Where a highlight stands among a note's, which decides what is either side of it. */
function placeOf(at: number, of: number): Place {
  if (of === 1) return 'only';
  if (at === 0) return 'first';
  return at === of - 1 ? 'last' : 'between';
}

/**
 * A note a test lists rather than draws: the styles of its highlights, and for
 * a write to one of them, where it stands and the edit by hand made to it.
 */
interface Listed {
  readonly highlights: readonly ListedHighlight[];
  readonly place?: Place;
  readonly edit?: HandEdit;
}

/**
 * `count` highlights for the `at`th listed note, their styles and anchors
 * turning with `at`, so the listed notes hold every style and every anchor.
 */
const highlightsFor = (at: number, count: number): ListedHighlight[] =>
  Array.from({ length: count }, (_, k) => ({
    style: STYLES[(5 * at + k) % STYLES.length]!,
    anchor: EVERY_ANCHOR[(3 * at + k) % EVERY_ANCHOR.length]!,
    ...(k === 0 && EVERY_WORD[at] !== undefined && { comment: EVERY_WORD[at] }),
  }));

/** Notes of 1 to 5 highlights, one in each style and every anchor among them. */
const EVERY_COUNT: readonly Listed[] = [1, 2, 3, 4, 5].map((count) => ({
  highlights: Array.from({ length: count }, (_, k) => {
    const n = (count * (count - 1)) / 2 + k;
    return {
      style: STYLES[n % STYLES.length]!,
      anchor: EVERY_ANCHOR[n % EVERY_ANCHOR.length]!,
      // The first four hold a comment of every word, one joined by each separator.
      ...(EVERY_WORD[n] !== undefined && { comment: EVERY_WORD[n] }),
    };
  }),
}));

/**
 * How many highlights a listed write's note has, by the place written to and
 * the edit: as few as the place allows, and between others every count from 3.
 */
const countFor = (place: Place, edit: number) =>
  ({ only: 1, first: 2, between: 3 + (edit % 3), last: 2 })[place];

/** A write to every place with every edit by hand to the highlight written to. */
const PLACED_EDITS: readonly Listed[] = PLACES.flatMap((place, p) =>
  HAND_EDITS.map((edit, e) => ({
    place,
    edit,
    highlights: highlightsFor(4 * p + e, countFor(place, e)),
  })),
);

/** A test's notes: the listed ones, then `RUNS` drawn ones. */
const notesOf = (listed: readonly Listed[]): (Listed | null)[] => [
  ...listed,
  ...Array.from({ length: RUNS }, () => null),
];

/** Where the highlight at `place` is among `count`; a drawn one where none is listed. */
function indexAt(place: Place | undefined, count: number): number {
  if (place === undefined) return Math.floor(random() * count);
  if (place === 'last') return count - 1;
  if (place === 'between') return 1 + Math.floor(random() * (count - 2));
  return 0;
}

/** The note edited by hand, and the highlight in it to write to, recorded by where it stands and its edit. */
function handEditedWithTarget(
  written: string,
  listed: Listed | null,
): { text: string; target: HighlightBlock } {
  const count = readHighlights(written, noteBlocks).length;
  const at = indexAt(listed?.place, count);
  const { text, edits } = editedByHand(
    written,
    listed?.edit === undefined ? undefined : { at, edit: listed.edit },
  );
  const blocks = readHighlights(text, noteBlocks);
  const target = blocks[at]!;
  const place = placeOf(at, blocks.length);
  saw(`written to ${place}`);
  saw(`written to ${place} after ${edits.get(target.id)}`);
  return { text, target };
}

const wordsIn = (where: string) => [
  ...WORDS.map((word) => `${where} has ${word}`),
  ...SEPARATORS.map((separator) => `${where} joined by ${JSON.stringify(separator)}`),
];

/** Every shape a note and the highlights appended to it hold that the property turns on. */
const EVERY_NOTE_SHAPE = [
  ...FILLER.map(({ name }) => `filler ${name}`),
  ...[1, 2, 3, 4, 5].map((asked) => `${asked} highlights appended`),
  ...[0, 1, 2, 3].map((rects) => `pdf quote in ${rects} rects`),
  'pdf area',
  'epub',
  ...[true, false].flatMap((ending) =>
    [true, false].map((id) => `kindle ending ${ending}, with an id ${id}`),
  ),
  ...STYLES.map(({ mark, color }) => `${mark} in ${color}`),
  'commented true',
  'commented false',
  ...['quote', 'comment', 'anchor'].flatMap(wordsIn),
  // The prose's newlines are made spaces (see FILLER), so only its words count.
  ...WORDS.map((word) => `prose has ${word}`),
];

/** Every edit by hand, each a person makes in Obsidian. */
const EVERY_HAND_EDIT = HAND_EDITS.map((edit) => `hand edit: ${edit}`);

/** Every place the highlight written to can stand, with every edit by hand to it. */
const EVERY_PLACED_EDIT = PLACES.flatMap((place) => [
  `written to ${place}`,
  ...HAND_EDITS.map((edit) => `written to ${place} after ${edit}`),
]);

const missing = (shapes: readonly string[], drawn: ReadonlySet<string>) =>
  shapes.filter((shape) => !drawn.has(shape));

describe('literature notes under any edits', () => {
  it('reads back every highlight appended, with fresh ids, and writes only after the last byte', () => {
    const shapes = drawing(0);
    for (const [run, listed] of notesOf(EVERY_COUNT).entries()) {
      const before = literatureNote(run);
      const added = newHighlights(listed?.highlights);
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
    const shapes = drawing(1);
    for (const [run, listed] of notesOf(PLACED_EDITS).entries()) {
      const { text: written } = appendHighlights({
        text: literatureNote(run),
        highlights: newHighlights(listed?.highlights),
        random,
        noteBlocks,
      });
      const { text, target } = handEditedWithTarget(written, listed);
      const comment = typedFor(run);
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
          ...EVERY_PLACED_EDIT,
          'typed nothing',
          ...wordsIn('typed'),
        ],
        shapes,
      ),
    ).toEqual([]);
  });

  it('writes back the same bytes for every comment as it reads', () => {
    const shapes = drawing(2);
    for (const [run, listed] of notesOf(EVERY_COUNT).entries()) {
      const { text: written } = appendHighlights({
        text: literatureNote(run),
        highlights: newHighlights(listed?.highlights),
        random,
        noteBlocks,
      });
      const { text } = editedByHand(written);
      for (const block of readHighlights(text, noteBlocks)) {
        expect(
          withHighlightComment({ text, id: block.id, comment: block.comment, noteBlocks }),
        ).toBe(text);
      }
    }
    expect(missing([...EVERY_NOTE_SHAPE, ...EVERY_HAND_EDIT], shapes)).toEqual([]);
  });

  it('removes only the highlight it is given, and removing all it added gives the note back', () => {
    const shapes = drawing(3);
    for (const [run, listed] of notesOf(PLACED_EDITS).entries()) {
      const before = `${literatureNote(run).trimEnd()}\n`;
      const { text: written, highlights } = appendHighlights({
        text: before,
        highlights: newHighlights(listed?.highlights),
        random,
        noteBlocks,
      });
      const { text, target } = handEditedWithTarget(written, listed);
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
    expect(
      missing([...EVERY_NOTE_SHAPE, ...EVERY_HAND_EDIT, ...EVERY_PLACED_EDIT], shapes),
    ).toEqual([]);
  });
});
