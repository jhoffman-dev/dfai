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
import { EVERY_PIECE } from './writer-listed.test-support.ts';

/*
 * The promise of P26-01: an id given to any block of a note, in any place a
 * block can take one, is the only change to the file — every other byte stays
 * where it was — and the note reads it back on that block.
 *
 * The listed notes hold every shape that promise turns on (`EVERY_SHAPE`):
 * every piece of the generator's text ending the line an id follows, in each
 * kind of block that takes one on its line; every kind of block and list
 * nested two deep; each block that takes its id on a line of its own before
 * each kind of block and at the end; and ids already in the note. 400 seeds
 * drew most of them, and took 16 s on CI to do it (#888). A few seeds still
 * run, for what nobody thought to list.
 */

const SEEDS = 8;

/** The blocks whose id follows the words of their line, and the lists whose items' ids do. */
const LINE_HOMES = ['paragraph', 'heading', 'bulletList', 'orderedList', 'taskList'] as const;
/** The blocks that take their id on a line of their own after them. */
const OWN_LINE = ['bulletList', 'orderedList', 'taskList', 'blockquote', 'callout', 'table'];
const TOP_KINDS = [...OWN_LINE, 'paragraph', 'heading', 'bookmark', 'blockEmbed'];
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

/** A block with an id already: the places left open in it are the ones a listed note is for. */
const withId = (node: EditorNode): EditorNode => ({
  ...node,
  attrs: { ...node.attrs, anchor: 'given' },
});

/**
 * Every piece ending the line an id follows, in each kind of block that writes
 * it there; a list has its own id already, so its item's place is the one tried.
 */
const endingInEveryPiece = EVERY_PIECE.flatMap((_, at) =>
  LINE_HOMES.map((home) => {
    const written = block(home, `${piece(at + 7)}${piece(at)}`);
    return note(home in ITEM_OF ? withId(written) : written);
  }),
);

/** Each kind of block holding each kind of list, holding each kind of list or none. */
const nestedTwoDeep = ['bulletList', 'orderedList', 'taskList', 'blockquote', 'callout'].flatMap(
  (outer) =>
    LISTS.flatMap((middle) =>
      [undefined, ...LISTS].map((inner) =>
        note(block(outer, 'a k', list(middle, 'b', inner && list(inner, 'c')))),
      ),
    ),
);

/** Each block whose id takes a line of its own, before each kind of block; that one has an id. */
const beforeEveryKind = OWN_LINE.flatMap((first, f) =>
  TOP_KINDS.map((next, n) => {
    const after = block(next, 'k a');
    const anchored = (f + n) % 2 === 0 && next !== 'bookmark' && next !== 'blockEmbed';
    return note(block(first, 'a k'), anchored ? withId(after) : after);
  }),
);

const LISTED: readonly EditorDocument[] = [
  ...endingInEveryPiece,
  ...nestedTwoDeep,
  ...beforeEveryKind,
];

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
    ...(next !== null && OWN_LINE.includes(node.type) ? [`${node.type} before ${next}`] : []),
    ...(anchorsIn(doc).size > 0 ? ['an id already in the note'] : []),
  ];
}

/** Every shape the promise turns on, named from the lists above and the generator's. */
const EVERY_SHAPE = [
  ...EVERY_PIECE.flatMap((p) =>
    [
      'paragraph',
      'heading',
      'bulletList>listItem',
      'orderedList>listItem',
      'taskList>taskItem',
    ].map((chain) => `${JSON.stringify(p)} ends ${chain}`),
  ),
  ...['paragraph', 'heading', ...OWN_LINE].map((type) => `place ${type}`),
  ...['bulletList', 'orderedList', 'taskList', 'blockquote', 'callout'].flatMap((outer) => {
    const head = ITEM_OF[outer] ? `${outer}>${ITEM_OF[outer]}` : outer;
    return LISTS.flatMap((middle) => [
      `place ${head}>${middle}>listItem`,
      ...LISTS.map((inner) => `place ${head}>${middle}>listItem>${inner}>listItem`),
    ]);
  }),
  ...OWN_LINE.flatMap((first) => [...TOP_KINDS, 'end'].map((next) => `${first} before ${next}`)),
  'an id already in the note',
];

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

describe('giving any block an id changes nothing else in the file', () => {
  it(`holds for every open place in the listed notes and ${SEEDS} seeded ones`, () => {
    const notes = [
      ...LISTED.map((doc, at) => ({ name: `listed ${at}`, doc })),
      ...Array.from({ length: SEEDS }, (_, at) => ({
        name: `seed ${at + 1}`,
        doc: generatedDocument(at + 1),
      })),
    ];
    const failures: string[] = [];
    const tried = new Set<string>();
    for (const { name, doc } of notes) {
      const body = noteOnDisk(doc);
      const parsed = parseMarkdownBody(body);
      for (const at of openPlaces(parsed.doc)) {
        for (const shape of shapesAt(parsed.doc, doc, at)) tried.add(shape);
        const failure = failureAt(body, parsed, at);
        if (failure !== null) failures.push(`${name} ${failure}`);
      }
    }
    expect(failures.slice(0, 5), `${failures.length} places`).toEqual([]);
    expect(EVERY_SHAPE.filter((shape) => !tried.has(shape))).toEqual([]);
  });
});
