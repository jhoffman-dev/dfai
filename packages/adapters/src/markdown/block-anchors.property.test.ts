import { describe, expect, it } from 'vitest';
import {
  anchorPlaces,
  anchorsIn,
  locateFragment,
  withAnchorAt,
  type EditorDocument,
  type EditorNode,
  type ParsedBody,
} from '@dfai/domain';
import { parseMarkdownBody, serializeMarkdownBody } from './markdown-blocks.ts';
import { generatedDocument, TARGETS } from './writer-fuzz.test-support.ts';
import {
  EVERY_PIECE,
  INLINE_KINDS,
  inlineOfKind,
  OUTERS,
  TOP_KINDS,
} from './writer-listed.test-support.ts';
import { inlineKindOf } from './writer-shapes.test-support.ts';

/*
 * The promise of P26-01: an id given to any block of a note, in any place a
 * block can take one, is the only change to the file — every other byte stays
 * where it was — and the note reads it back on that block.
 *
 * The listed notes, a family at a time, hold every shape that promise turns
 * on (`FAMILIES`):
 * every piece of the generator's text ending the line an id follows, in each
 * kind of block that takes one on its line; every kind of block and list
 * nested two deep; each block that takes its id on a line of its own before
 * each kind of block and at the end; and ids already in the note. 400 seeds
 * drew most of them, and took 16 s on CI to do it (#888). A few seeds still
 * run, for what nobody thought to list.
 */

/**
 * 50 seeds, in runs of 17 so each `it` stays short on CI: their notes hold
 * more places than the writer's seeds do.
 */
const SEED_RUNS = [
  [1, 17],
  [18, 34],
  [35, 50],
] as const;

/** The blocks whose id follows the words of their line, and the lists whose items' ids do. */
const LINE_HOMES = ['paragraph', 'heading', 'bulletList', 'orderedList', 'taskList'] as const;
/** The blocks that take their id on a line of their own after them. */
const OWN_LINE = ['bulletList', 'orderedList', 'taskList', 'blockquote', 'callout', 'table'];
const LISTS = ['bulletList', 'orderedList'] as const;
const ITEM_OF: Readonly<Record<string, string>> = {
  bulletList: 'listItem',
  orderedList: 'listItem',
  taskList: 'taskItem',
};

const piece = (at: number) => EVERY_PIECE[at % EVERY_PIECE.length]!;
const words = (value: string): EditorNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text: value }],
});

/** A list of `type` with one item of `value`, holding `inner` after it if given. */
function list(type: string, value: string, inner?: EditorNode): EditorNode {
  const item = ITEM_OF[type]!;
  return {
    type,
    ...(type === 'orderedList' && { attrs: { start: value.length % 2 === 0 ? 1 : 3 } }),
    content: [
      {
        type: item,
        ...(item === 'taskItem' && { attrs: { checked: value.length % 2 === 0 } }),
        content: [words(value), ...(inner ? [inner] : [])],
      },
    ],
  };
}

/** One block of `type`, its words `value`, holding `inner` where it can hold a block. */
function block(type: string, value: string, inner?: EditorNode): EditorNode {
  const after = inner ? [inner] : [];
  switch (type) {
    case 'paragraph':
      return words(value);
    case 'heading':
      return {
        type,
        attrs: { level: 1 + (value.length % 6) },
        content: [{ type: 'text', text: value }],
      };
    case 'blockquote':
      return { type, content: [words(value), ...after] };
    case 'callout':
      return {
        type,
        attrs: { kind: 'note', title: null, fold: null },
        content: [words(value), ...after],
      };
    case 'table':
      return {
        type,
        attrs: { align: [null, null] },
        content: ['tableHeader', 'tableCell'].map((cell) => ({
          type: 'tableRow',
          content: [cell, cell].map((kind) => ({ type: kind, content: [words(value)] })),
        })),
      };
    case 'bookmark':
      return {
        type,
        attrs: { target: TARGETS[value.length % TARGETS.length]!, heading: null, alias: null },
      };
    case 'blockEmbed':
      return { type, attrs: { target: TARGETS[0]!, heading: '#^ab12', alias: null } };
    default:
      return list(type, value, inner);
  }
}

const note = (...content: EditorNode[]): EditorDocument => ({ type: 'doc', content });

/** A block with an id already: the places left open in it are the ones a note is for. */
const withId = (node: EditorNode): EditorNode => ({
  ...node,
  attrs: { ...node.attrs, anchor: 'given' },
});

const HOME_NAMES: Readonly<Record<string, string>> = {
  paragraph: 'a paragraph',
  heading: 'a heading',
  bulletList: 'a bullet item',
  orderedList: 'a numbered item',
  taskList: 'a task',
};

/** The chain of block kinds to the place an id follows the words of, in a `home`. */
const chainIn = (home: string) => (ITEM_OF[home] ? `${home}>${ITEM_OF[home]}` : home);

/**
 * Every piece ending the line an id follows, in a `home`; a list has its own
 * id already, so its item's place is the one tried.
 */
const endingInEveryPiece = (home: string): EditorDocument[] =>
  EVERY_PIECE.map((_, at) => {
    const written = block(home, `${piece(at + 7)}${piece(at)}`);
    return note(home in ITEM_OF ? withId(written) : written);
  });

/** Each kind of block holding each kind of list, holding each kind of list or none. */
const nestedTwoDeep = OUTERS.flatMap((outer) =>
  LISTS.flatMap((middle) =>
    [undefined, ...LISTS].map((inner) =>
      note(block(outer, 'a k', list(middle, 'b', inner && list(inner, 'c')))),
    ),
  ),
);

/** Each block whose id takes a line of its own, before each kind of block, and at the end. */
const beforeEveryKind = OWN_LINE.flatMap((first) => [
  note(block(first, 'a k')),
  ...TOP_KINDS.map((next) => note(block(first, 'a k'), block(next, 'k a'))),
]);

/** Each block that can hold an id holding one, before another of its kind with none. */
const withIdsAlready = [...OWN_LINE, 'paragraph', 'heading'].map((kind) =>
  note(withId(block(kind, 'a k')), block(kind, 'k a')),
);

/** `node` with `content` as the words of the line an id follows: its own, or its first item's. */
function withLine(node: EditorNode, content: EditorNode[]): EditorNode {
  if (!ITEM_OF[node.type]) return { ...node, content };
  const [item] = node.content ?? [];
  const [first, ...rest] = item?.content ?? [];
  return { ...node, content: [{ ...item!, content: [{ ...first!, content }, ...rest] }] };
}

/** A `home` whose line ends in an inline of each kind, there to be the last thing before an id. */
const endingInEveryInline = (home: string): EditorDocument[] =>
  INLINE_KINDS.map((kind, at) => {
    const written = withLine(block(home, 'a'), [
      { type: 'text', text: 'a ' },
      inlineOfKind(kind, at),
    ]);
    return note(home in ITEM_OF ? withId(written) : written);
  });

const pieceFamily = (home: string) => `every piece ending the words of ${HOME_NAMES[home]}`;
const inlineFamily = (home: string) =>
  `each kind of inline ending the words of ${HOME_NAMES[home]}`;
const NESTED_FAMILY = 'every kind of block holding lists two deep';
const OWN_LINE_FAMILY = 'every block with its id on a line of its own, before each kind of block';
const IDS_FAMILY = 'ids already in the note';

/** The listed notes of each family. */
const NOTES_BY_FAMILY: Readonly<Record<string, readonly EditorDocument[]>> = {
  ...Object.fromEntries(LINE_HOMES.map((home) => [pieceFamily(home), endingInEveryPiece(home)])),
  [NESTED_FAMILY]: nestedTwoDeep,
  [OWN_LINE_FAMILY]: beforeEveryKind,
  ...Object.fromEntries(LINE_HOMES.map((home) => [inlineFamily(home), endingInEveryInline(home)])),
  [IDS_FAMILY]: withIdsAlready,
};

/**
 * The shapes each family's notes must try between them, named apart from the
 * notes from the lists above and the generator's, so a family whose notes
 * are taken out is seen.
 */
const SHAPES_BY_FAMILY: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(
    LINE_HOMES.map((home) => [
      pieceFamily(home),
      [
        `place ${chainIn(home)}`,
        ...EVERY_PIECE.map((p) => `${JSON.stringify(p)} ends ${chainIn(home)}`),
      ],
    ]),
  ),
  [NESTED_FAMILY]: OUTERS.flatMap((outer) =>
    LISTS.flatMap((middle) => [
      `place ${chainIn(outer)}>${middle}>listItem`,
      ...LISTS.map((inner) => `place ${chainIn(outer)}>${middle}>listItem>${inner}>listItem`),
    ]),
  ),
  [OWN_LINE_FAMILY]: OWN_LINE.flatMap((first) => [
    `place ${first}`,
    ...[...TOP_KINDS, 'end'].map((next) => `${first} before ${next}`),
  ]),
  ...Object.fromEntries(
    LINE_HOMES.map((home) => [
      inlineFamily(home),
      INLINE_KINDS.map((kind) => `id after ${kind} in ${chainIn(home)}`),
    ]),
  ),
  [IDS_FAMILY]: ['an id already in the note'],
};

/** Each family with listed notes, and the shapes they are there to try between them. */
const FAMILIES = Object.entries(NOTES_BY_FAMILY).map(([name, notes]) => {
  const shapes = SHAPES_BY_FAMILY[name];
  if (shapes === undefined) throw new Error(`no shapes named for ${name}`);
  return { name, notes, shapes };
});

/** A note as it would be on disk: written once, the way the app writes. */
function noteOnDisk(doc: EditorDocument): string {
  return serializeMarkdownBody({ originalBody: '', parsed: parseMarkdownBody(''), doc });
}

/** Every place in the note that could take an id and has none, as paths from the document. */
function openPlaces(doc: EditorDocument): number[][] {
  return doc.content.flatMap((top, index) =>
    anchorPlaces(top)
      .map((path) => [index, ...path])
      .filter((at) => typeof nodeAt(doc, at).attrs?.['anchor'] !== 'string'),
  );
}

const nodeAt = (doc: EditorDocument, at: readonly number[]): EditorNode =>
  at.slice(1).reduce((current, step) => current.content?.[step] ?? current, doc.content[at[0]!]!);

const chainAt = (doc: EditorDocument, at: readonly number[]): string =>
  at.map((_, depth) => nodeAt(doc, at.slice(0, depth + 1)).type).join('>');

/**
 * The shapes the promise turns on that giving an id at `at` in the note read
 * from disk tries. What its line ends with is told by the note as it was
 * given, where the same place is: on disk an ending space is gone, and
 * `www.` reads as a link and a dot.
 */
function shapesAt(doc: EditorDocument, given: EditorDocument, at: readonly number[]): string[] {
  const chain = chainAt(doc, at);
  const node = nodeAt(doc, at);
  const givenNode =
    given.content[at[0]!] && chainAt(given, at) === chain ? nodeAt(given, at) : null;
  // The words an id follows: the block's own, or its item's first line.
  const line = givenNode?.type.endsWith('Item') ? givenNode.content?.[0] : givenNode;
  const last = line?.type === 'paragraph' || line?.type === 'heading' ? line.content?.at(-1) : null;
  const ends = EVERY_PIECE.filter((p) => last?.type === 'text' && last.text?.endsWith(p)).map(
    (p) => `${JSON.stringify(p)} ends ${chain}`,
  );
  const next = at.length === 1 ? (doc.content[at[0]! + 1]?.type ?? 'end') : null;
  return [
    `place ${chain}`,
    ...ends,
    ...(last ? [`id after ${inlineKindOf(last)} in ${chain}`] : []),
    ...(next !== null && OWN_LINE.includes(node.type) ? [`${node.type} before ${next}`] : []),
    ...(anchorsIn(doc).size > 0 ? ['an id already in the note'] : []),
  ];
}

/** The id's own writing, when `after` is `before` with only that put in; null otherwise. */
function insertion(before: string, after: string): string | null {
  const caret = after.indexOf('^zz9');
  for (const written of [' ^zz9', '\n\n^zz9', '\r\n\r\n^zz9']) {
    const start = caret - (written.length - '^zz9'.length);
    if (start < 0 || after.slice(start, caret + 4) !== written) continue;
    if (after.slice(0, start) + after.slice(caret + 4) === before) return written;
  }
  return null;
}

/** What went wrong giving the note an id at `at`, or null if nothing did. */
function failureAt(body: string, parsed: ParsedBody, at: number[]): string | null {
  const doc = withAnchorAt(parsed.doc, at, 'zz9');
  const written = serializeMarkdownBody({ originalBody: body, parsed, doc });
  const added = insertion(body, written);
  const reread = parseMarkdownBody(written).doc;
  const found = locateFragment(reread, { kind: 'block', id: 'zz9' });
  const ok =
    added !== null &&
    /^(?: \^zz9|\r?\n\r?\n\^zz9)$/.test(added) &&
    JSON.stringify(found) === JSON.stringify(at) &&
    anchorsIn(reread).size === anchorsIn(parsed.doc).size + 1;
  return ok
    ? null
    : `at ${JSON.stringify(at)} added=${JSON.stringify(added)} found=${JSON.stringify(found)} ids=${anchorsIn(reread).size}/${anchorsIn(parsed.doc).size}`;
}

/** Every place in `notes` that failed to take an id alone, the shapes tried, and how many places. */
function tryEveryOpenPlace(notes: readonly EditorDocument[]) {
  const failures: string[] = [];
  const tried = new Set<string>();
  let places = 0;
  notes.forEach((doc, index) => {
    const body = noteOnDisk(doc);
    const parsed = parseMarkdownBody(body);
    for (const at of openPlaces(parsed.doc)) {
      places += 1;
      for (const shape of shapesAt(parsed.doc, doc, at)) tried.add(shape);
      const failure = failureAt(body, parsed, at);
      if (failure !== null) failures.push(`note ${index} ${failure}`);
    }
  });
  return { failures, tried, places };
}

describe('giving any block an id changes nothing else in the file', () => {
  it('lists the notes of every family of shapes', () => {
    expect(Object.keys(SHAPES_BY_FAMILY).filter((name) => !(name in NOTES_BY_FAMILY))).toEqual([]);
  });

  it.each(FAMILIES.map((family) => [family.name, family] as const))(
    'holds for every open place in %s, which its listed notes all try',
    (_name, { notes, shapes }) => {
      const { failures, tried } = tryEveryOpenPlace(notes);
      expect(failures.slice(0, 5), `${failures.length} places`).toEqual([]);
      expect(shapes.filter((shape) => !tried.has(shape))).toEqual([]);
    },
  );

  it.each(SEED_RUNS)('holds for every open place in seeded notes %i to %i', (first, last) => {
    const seeded = Array.from({ length: last - first + 1 }, (_, at) =>
      generatedDocument(first + at),
    );
    const { failures, places } = tryEveryOpenPlace(seeded);
    expect(failures.slice(0, 5), `${failures.length} places`).toEqual([]);
    expect(places, 'places tried').toBeGreaterThan(seeded.length);
  });
});
