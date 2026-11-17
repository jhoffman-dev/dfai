import type { EditorDocument, EditorMark, EditorNode } from '@dfai/domain';
import {
  CAN_CARRY_AN_ID,
  EMBED_FRAGMENTS,
  HREFS,
  PIECES,
  SRCS,
  TARGETS,
} from './writer-fuzz.test-support.ts';

/**
 * Listed editor documents for the writer's property tests (#888), built from
 * the seeded generator's own lists: every shape the property turns on
 * (`writer-shapes.test-support.ts`), by rotation. 3000 seeds drew most of
 * them and took up to 105 s on CI to do it; these draw all of them in a
 * fraction of the work.
 */

/** Each of the generator's pieces of text once: it draws some more often than others. */
export const EVERY_PIECE: readonly string[] = [...new Set(PIECES)];

/** The pieces GFM can read as an address typed bare, which run on into the words beside them. */
export const ADDRESSES = EVERY_PIECE.filter((p) => /^(?:www\.|http:\/\/|\w+@)/.test(p));
/** The pieces that open markup when bare — a tag, a comment, a link — so a writer escapes them. */
export const OPENERS = EVERY_PIECE.filter((p) => /^(?:<|!?\[)/.test(p));
/** The pieces that are words: what an address runs on into. */
const WORDS = EVERY_PIECE.filter((p) => /^\w+$/.test(p));

/** The marks the generator puts on text, and none. */
export const MARKINGS = ['none', 'bold', 'italic', 'strike', 'code', 'link'] as const;
/** The marks it puts on a wiki link, and none. */
export const LINK_MARKINGS = ['none', 'bold', 'italic', 'strike', 'link'] as const;

/** Where the text of a text block stands: the block itself, or the block that holds it. */
export const CONTAINERS = [
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
  'blockquote',
  'callout',
  'tableHeader',
  'tableCell',
] as const;
/** The blocks that hold text blocks of their own. */
export const HOLDERS = new Set<string>(['listItem', 'taskItem', 'blockquote', 'callout']);
export const NESTED = ['paragraph', 'bulletList', 'orderedList', 'blockquote'] as const;

const piece = (at: number) => EVERY_PIECE[at % EVERY_PIECE.length]!;
const cycle = <T>(options: readonly T[], at: number): T => options[at % options.length]!;

function marked(marking: string, at: number): EditorMark[] {
  if (marking === 'none') return [];
  if (marking === 'link') return [{ type: 'link', attrs: { href: cycle(HREFS, at), title: null } }];
  return [{ type: marking }];
}

function text(value: string, marks: EditorMark[] = []): EditorNode {
  return { type: 'text', text: value, ...(marks.length > 0 && { marks }) };
}

const paragraph = (content: EditorNode[]): EditorNode => ({ type: 'paragraph', content });
const noteOf = (content: EditorNode[]): EditorDocument => ({ type: 'doc', content });

/** A line that starts with one piece and ends with another: the two ends the writer escapes. */
const line = (first: number): EditorNode[] => [text(`${piece(first)}${piece(first + 29)}`)];

/** How many lines of pieces a listed block holds: few, so one that misreads does not hide the rest. */
const LINES = 6;
const linesFrom = (first: number) => Array.from({ length: LINES }, (_, n) => first + n);

const lineItem = (type: string, at: number): EditorNode => ({
  type,
  ...(type === 'taskItem' && { attrs: { checked: at % 2 === 0 } }),
  content: [paragraph(line(at))],
});

/** The pieces from `first` at each end of a line, in each kind of text block of `group`. */
const AT_THE_ENDS: Readonly<Record<string, (lines: number[], first: number) => EditorNode[]>> = {
  'paragraphs and headings': (lines) => [
    ...lines.map((at) => paragraph(line(at))),
    ...lines.map((at) => ({ type: 'heading', attrs: { level: 1 + (at % 6) }, content: line(at) })),
  ],
  'list and task items': (lines) => [
    { type: 'bulletList', content: lines.map((at) => lineItem('listItem', at)) },
    { type: 'taskList', content: lines.map((at) => lineItem('taskItem', at)) },
  ],
  'quotes and callouts': (lines, first) => [
    { type: 'blockquote', content: lines.map((at) => paragraph(line(at))) },
    callout(
      lines.map((at) => paragraph(line(at))),
      first,
    ),
  ],
  'table cells': (lines) => [0, 2, 4].map((n) => table(lines[n]!, lines[n + 1]!)),
};

/** The pieces from `first` under `marking`, each beside an unmarked one. */
const underMark =
  (marking: string, m: number) =>
  (lines: number[]): EditorNode[] =>
    lines.map((at) => paragraph([text(piece(at), marked(marking, at)), text(piece(at + 17 * m))]));

/** The pieces from `first` in images' descriptions. */
const inDescriptions = (_lines: number[], first: number): EditorNode[] => [
  paragraph([0, 2, 4].map((n) => image(first + n, `${piece(first + n)}${piece(first + n + 1)}`))),
];

/** Every piece, `LINES` at a time, through `build`: one note for each. */
const everyPieceThrough = (build: (lines: number[], first: number) => EditorNode[]) =>
  Array.from({ length: Math.ceil(EVERY_PIECE.length / LINES) }, (_, n) =>
    noteOf(build(linesFrom(n * LINES), n * LINES)),
  );

function table(left: number, right: number): EditorNode {
  return {
    type: 'table',
    attrs: { align: [null, null] },
    content: ['tableHeader', 'tableCell'].map((type, row) => ({
      type: 'tableRow',
      content: [left, right].map((at) => ({ type, content: [paragraph(line(at + 31 * row))] })),
    })),
  };
}

const callout = (content: EditorNode[], at: number): EditorNode => ({
  type: 'callout',
  attrs: { kind: 'note', title: at % 2 === 0 ? 'Title' : null, fold: null },
  content,
});

const image = (at: number, alt: string | null): EditorNode => ({
  type: 'image',
  attrs: { src: cycle(SRCS, at), alt, title: null },
});

function wikiLink(at: number): EditorNode {
  const marking = cycle(LINK_MARKINGS, at);
  return {
    type: 'wikiLink',
    attrs: {
      target: cycle(TARGETS, at),
      heading: at % 4 === 0 ? '#Part' : null,
      alias: Math.floor(at / 8) % 2 === 0 ? 'shown' : null,
      ...(at % 3 === 0 && { embed: true }),
    },
    ...(marking !== 'none' && { marks: marked(marking, at) }),
  };
}

/** The block an item, quote or callout holds after its first paragraph. */
function nested(kind: string, at: number): EditorNode {
  const words = paragraph([text('a k')]);
  if (kind === 'paragraph') return words;
  if (kind === 'blockquote') return { type: 'blockquote', content: [words] };
  return {
    type: kind,
    ...(kind === 'orderedList' && { attrs: { start: at % 2 === 0 ? 1 : 3 } }),
    content: [{ type: 'listItem', content: [words] }],
  };
}

/**
 * A line of words with a wiki link and an image in it, and a line break where
 * it is `broken`'s turn: the inline shapes the pieces leave out.
 */
function words(at: number, broken: boolean): EditorNode[] {
  return [
    text('a '),
    wikiLink(at),
    image(at, at % 2 === 1 ? 'k' : null),
    ...(broken ? [{ type: 'hardBreak' }, text('k ')] : []),
    text(' k', marked(cycle(MARKINGS, at), at)),
  ];
}

/** Turns enough for every heading level, and with two of each, every target, to come round. */
const KIND_TURNS = 6;

/**
 * Every kind of block the generator makes, by turns: each kind of list,
 * item and nested block, every heading level, link, atom and embed, a line
 * break in each kind of text block, and an id on every node whose turn it is.
 */
function kindsAt(at: number): EditorNode[] {
  // Each kind of text block has its own turn of atoms and marks, and a line break every other turn.
  const lead = (container: string) =>
    paragraph(words(at + 2 * CONTAINERS.indexOf(container as never), at % 2 === 0));
  const listType = cycle(['bulletList', 'orderedList'], at);
  const items = (type: string, turn: number) => [
    {
      type,
      ...(type === 'taskItem' && { attrs: { checked: at % 2 === 0 } }),
      content: [lead(type), nested(cycle(NESTED, at + turn), at)],
    },
  ];
  const content: EditorNode[] = [
    lead('paragraph'),
    {
      type: 'heading',
      attrs: { level: 1 + (at % 6) },
      content: words(at + 2 * CONTAINERS.indexOf('heading'), at % 2 === 0),
    },
    {
      type: listType,
      ...(listType === 'orderedList' && { attrs: { start: Math.floor(at / 2) % 2 === 0 ? 1 : 3 } }),
      content: items('listItem', 0),
    },
    { type: 'taskList', content: items('taskItem', 1) },
    { type: 'blockquote', content: [lead('blockquote'), nested(cycle(NESTED, at + 2), at)] },
    callout([lead('callout'), nested(cycle(NESTED, at + 3), at)], at),
    {
      ...table(at, at + 1),
      content: ['tableHeader', 'tableCell'].map((type) => ({
        type: 'tableRow',
        content: [
          { type, content: [lead(type)] },
          { type, content: [paragraph([text('k')])] },
        ],
      })),
    },
    ...[at, at + KIND_TURNS].flatMap((turn) => [
      {
        type: 'bookmark',
        attrs: {
          target: cycle(TARGETS, turn),
          heading: turn % 4 === 0 ? '#Part' : null,
          alias: null,
        },
      },
      {
        type: 'blockEmbed',
        attrs: {
          target: cycle(TARGETS, turn + 2),
          heading: cycle(EMBED_FRAGMENTS, turn),
          alias: turn % 3 === 0 ? 'shown' : null,
        },
      },
    ]),
  ];
  return withIds(content, at);
}

/** An id on every other node that can carry one, the turn moved by `at`. */
function withIds(content: EditorNode[], at: number): EditorNode[] {
  let count = 0;
  const give = (node: EditorNode): EditorNode => {
    const inner = node.content?.map(give);
    const anchored = CAN_CARRY_AN_ID.has(node.type) && (count += 1) % 2 === at % 2;
    return {
      ...node,
      ...(anchored && { attrs: { ...node.attrs, anchor: `id${count}` } }),
      ...(inner !== undefined && { content: inner }),
    };
  };
  return content.map(give);
}

/**
 * Every ordered pair of `count` symbols, each once, as one sequence: a de
 * Bruijn sequence of order two, its first symbol put again at its end so the
 * pair that wraps round is in it too.
 */
function everyPairInOrder(count: number): number[] {
  const word = Array<number>(3).fill(0);
  const sequence: number[] = [];
  const extend = (t: number, p: number): void => {
    if (t > 2) {
      if (2 % p === 0) sequence.push(...word.slice(1, p + 1));
      return;
    }
    word[t] = word[t - p]!;
    extend(t + 1, p);
    for (let symbol = word[t - p]! + 1; symbol < count; symbol += 1) {
      word[t] = symbol;
      extend(t + 1, t);
    }
  };
  extend(1, 1);
  return [...sequence, sequence[0]!];
}

/** `sequence` in runs of `size`, each run starting with the last of the one before. */
const runsOf = <T>(sequence: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil((sequence.length - 1) / (size - 1)) }, (_, n) =>
    sequence.slice(n * (size - 1), n * (size - 1) + size),
  );

/**
 * The marks the generator puts together on one run of text: any of bold,
 * italic and strike, a link or not; or code alone.
 */
export const MARK_SETS: readonly (readonly string[])[] = [
  ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((bits) => {
    const set = ['bold', 'italic', 'strike'].filter((_, at) => (bits >> at) % 2 === 1);
    return [set, [...set, 'link']];
  }),
  ['code'],
];
/** A set of marks by name, or `none`. */
export const markSetKey = (types: readonly string[]) =>
  types.length === 0 ? 'none' : [...types].sort().join('+');

/** What can stand beside what in a line: text under each set of marks, and each atom. */
export const INLINE_KINDS = [...MARK_SETS.map(markSetKey), 'wikiLink', 'image', 'hardBreak'];

/** An inline node of `kind` (`INLINE_KINDS`), turned by `at`. */
export function inlineOfKind(kind: string, at: number): EditorNode {
  if (kind === 'wikiLink') return wikiLink(at);
  if (kind === 'image') return image(at, at % 2 === 0 ? 'k' : null);
  if (kind === 'hardBreak') return { type: 'hardBreak' };
  const types = kind === 'none' ? [] : kind.split('+');
  return text(
    piece(at),
    types.flatMap((type) => marked(type, at)),
  );
}

/**
 * `address` at the start of a line, straight before every address and a
 * word, with markup to escape after it, and straight after a word, under
 * every mark. GFM reads an address on over what follows it; the writer takes
 * off the escapes it can, and what it can take off at the start of a line
 * differs from after the word an edit puts before it.
 */
const runningOn = (address: string, a: number): EditorNode[] =>
  MARKINGS.flatMap((marking, m) =>
    [...ADDRESSES, cycle(WORDS, a + m)].map((next, n) => {
      const marks = marked(marking, a + m + n);
      return paragraph([
        text(`${address}${next}${cycle(OPENERS, a + m + n)}`, marks),
        text(' k '),
        text(`${cycle(WORDS, a + m + n)}${address}`, marks),
      ]);
    }),
  );

/** Every kind of text and atom straight after every other, in paragraphs of a few. */
const besideEveryInline = (): EditorNode[] =>
  runsOf(everyPairInOrder(INLINE_KINDS.length), 8).map((run, n) =>
    paragraph([
      text('k '),
      ...run.map((kind, at) => inlineOfKind(INLINE_KINDS[kind]!, 8 * n + at)),
      text(' k'),
    ]),
  );

/** Every kind of block the generator puts in a note. */
export const TOP_KINDS = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'callout',
  'table',
  'bookmark',
  'blockEmbed',
] as const;

function blockOfKind(kind: string, at: number): EditorNode {
  const words = () => paragraph([text(`${piece(at)}k`)]);
  switch (kind) {
    case 'heading':
      return { type: 'heading', attrs: { level: 1 + (at % 6) }, content: [text(`${piece(at)}k`)] };
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return {
        type: kind,
        ...(kind === 'orderedList' && { attrs: { start: at % 2 === 0 ? 1 : 3 } }),
        content: [
          {
            type: kind === 'taskList' ? 'taskItem' : 'listItem',
            ...(kind === 'taskList' && { attrs: { checked: at % 2 === 0 } }),
            content: [words()],
          },
        ],
      };
    case 'blockquote':
      return { type: kind, content: [words()] };
    case 'callout':
      return callout([words()], at);
    case 'table':
      return table(at, at + 1);
    case 'bookmark':
      return { type: kind, attrs: { target: cycle(TARGETS, at), heading: null, alias: null } };
    case 'blockEmbed':
      return {
        type: kind,
        attrs: { target: cycle(TARGETS, at), heading: cycle(EMBED_FRAGMENTS, at), alias: null },
      };
    default:
      return words();
  }
}

/** Every kind of block straight after every other, in notes of a few. */
const besideEveryBlock = (): EditorDocument[] =>
  runsOf(everyPairInOrder(TOP_KINDS.length), 12).map((run, n) =>
    noteOf(run.map((kind, at) => blockOfKind(TOP_KINDS[kind]!, 12 * n + at))),
  );

/**
 * A line holding every piece under every single mark between them, as `at`
 * turns, one run under a set of marks the generator puts together, and an
 * unmarked piece.
 */
const markedLine = (at: number): EditorNode[] => [
  ...MARKINGS.slice(1).map((marking, m) => text(piece(at + 11 * m), marked(marking, at + m))),
  text(
    piece(at + 5),
    cycle(MARK_SETS, at).flatMap((type) => marked(type, at)),
  ),
  // Unmarked last: `#x` unmarked before a marked run is markdown the writer
  // keeps as source, a limit of the format rather than of the writer.
  text(piece(at + 55)),
];

/** The kinds of text block, by what holds them, that `markedLine` runs through. */
export const MARKED_PLACES = [
  'heading',
  'listItem',
  'taskItem',
  'blockquote',
  'callout',
  'tableHeader',
  'tableCell',
];

/** Every piece under every mark, `LINES` lines at a time, in the text blocks of `place`. */
function markedIn(place: string, lines: number[]): EditorNode[] {
  const paragraphs = () => lines.map((at) => paragraph(markedLine(at)));
  switch (place) {
    case 'heading':
      return lines.map((at) => ({
        type: 'heading',
        attrs: { level: 1 + (at % 6) },
        content: markedLine(at),
      }));
    case 'listItem':
      return [
        {
          ...((lines[0]! / LINES) % 2 === 0
            ? { type: 'bulletList' }
            : { type: 'orderedList', attrs: { start: 1 } }),
          content: lines.map((at) => ({ type: 'listItem', content: [paragraph(markedLine(at))] })),
        },
      ];
    case 'taskItem':
      return [
        {
          type: 'taskList',
          content: lines.map((at) => ({
            type: 'taskItem',
            attrs: { checked: at % 2 === 0 },
            content: [paragraph(markedLine(at))],
          })),
        },
      ];
    case 'blockquote':
      return [{ type: 'blockquote', content: paragraphs() }];
    case 'callout':
      return [callout(paragraphs(), lines[0]!)];
    default:
      // A cell of `place` in each row, the other cells a word.
      return lines.map((at) => ({
        type: 'table',
        attrs: { align: [null, null] },
        content: ['tableHeader', 'tableCell'].map((type) => ({
          type: 'tableRow',
          content: [
            { type, content: [paragraph(type === place ? markedLine(at) : [text('k')])] },
            { type, content: [paragraph([text('k')])] },
          ],
        })),
      }));
  }
}

const LISTS = ['bulletList', 'orderedList'] as const;
/** The blocks a list can stand in, three deep: each kind of list, a quote and a callout. */
export const OUTERS = ['bulletList', 'orderedList', 'taskList', 'blockquote', 'callout'] as const;

/** A list of `type` holding one item of `at`'s words, and `inner` after them. */
function listOf(type: string, at: number, inner?: EditorNode): EditorNode {
  const item = type === 'taskList' ? 'taskItem' : 'listItem';
  return {
    type,
    ...(type === 'orderedList' && { attrs: { start: at % 2 === 0 ? 1 : 3 } }),
    content: [
      {
        type: item,
        ...(item === 'taskItem' && { attrs: { checked: at % 2 === 0 } }),
        content: [paragraph(line(at)), ...(inner ? [inner] : [])],
      },
    ],
  };
}

/** Each block that holds lists, holding each kind of list, holding each kind of list. */
const nestedThreeDeep = (): EditorNode[] =>
  OUTERS.flatMap((outer, o) =>
    LISTS.flatMap((middle, m) =>
      LISTS.map((inner, i) => {
        const at = 4 * o + 2 * m + i;
        const lists = listOf(middle, at + 1, listOf(inner, at + 2));
        if (outer === 'blockquote') return { type: outer, content: [paragraph(line(at)), lists] };
        if (outer === 'callout') return callout([paragraph(line(at)), lists], at);
        return listOf(outer, at, lists);
      }),
    ),
  );

/** The pieces that are only whitespace: a line of nothing else is blank. */
export const BLANKS = EVERY_PIECE.filter((p) => /^\s+$/u.test(p));

/** A blank-only line of each blank piece in each kind of text block. */
const blankLines = (): EditorNode[] =>
  BLANKS.flatMap((blank, at) => [
    paragraph([text('k')]),
    paragraph([text(blank)]),
    { type: 'heading', attrs: { level: 1 + at }, content: [text(blank)] },
    {
      type: 'bulletList',
      content: [
        lineItem('listItem', at),
        { type: 'listItem', content: [paragraph([text(blank)])] },
      ],
    },
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: false }, content: [paragraph([text(blank)])] },
      ],
    },
    { type: 'blockquote', content: [paragraph(line(at)), paragraph([text(blank)])] },
    callout([paragraph(line(at)), paragraph([text(blank)])], at),
    {
      type: 'table',
      attrs: { align: [null, null] },
      content: ['tableHeader', 'tableCell'].map((type) => ({
        type: 'tableRow',
        content: [
          { type, content: [paragraph([text(blank)])] },
          { type, content: [paragraph(line(at))] },
        ],
      })),
    },
  ]);

/** A family of listed documents: the shapes of one kind the property turns on. */
export interface ListedFamily {
  readonly name: string;
  readonly documents: readonly EditorDocument[];
}

/**
 * The listed documents, by family: every piece at each end of each kind of
 * text block, under each mark and in images' descriptions; every kind of
 * block, atom, link, embed and id, by turns; every kind of text and atom
 * beside every other, and of block; and each address running on into what
 * follows it.
 */
export const LISTED_FAMILIES: readonly ListedFamily[] = [
  ...Object.entries(AT_THE_ENDS).map(([group, build]) => ({
    name: `each piece at each end of ${group}`,
    documents: everyPieceThrough(build),
  })),
  ...MARKINGS.slice(1).map((marking, m) => ({
    name: `every piece under ${marking}`,
    documents: everyPieceThrough(underMark(marking, m)),
  })),
  { name: "every piece in an image's description", documents: everyPieceThrough(inDescriptions) },
  ...MARKED_PLACES.map((place) => ({
    name: `every piece under every mark in a ${place}`,
    documents: everyPieceThrough((lines) => markedIn(place, lines)),
  })),
  { name: 'lists nested three deep', documents: [noteOf(nestedThreeDeep())] },
  { name: 'blank-only lines in every kind of text block', documents: [noteOf(blankLines())] },
  {
    name: 'every kind of block, atom, link, embed and id',
    documents: Array.from({ length: KIND_TURNS }, (_, at) => noteOf(kindsAt(at))),
  },
  {
    name: 'every kind of text and atom beside every other',
    documents: [noteOf(besideEveryInline())],
  },
  { name: 'every kind of block beside every other', documents: besideEveryBlock() },
  ...ADDRESSES.map((address, a) => ({
    name: `${address} running on into what follows it`,
    documents: [noteOf(runningOn(address, a))],
  })),
];
