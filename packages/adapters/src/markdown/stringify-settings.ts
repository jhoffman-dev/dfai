import type { Join } from 'mdast-util-to-markdown';
import type { Options as StringifyOptions } from 'remark-stringify';
import './mdast-custom-nodes.ts';
import { writeEmphasis, writeStrong } from './emphasis-handlers.ts';
import { writeDelete } from './strikethrough-handler.ts';

/*
 * How DFAI writes markdown: remark-stringify's settings for every block the
 * editor saves (`markdown-blocks.ts`), and what a capture from Slack is
 * written with (`capture-markdown.ts`, #103), so a capture's bytes are those
 * the editor would write for the same tree.
 */

/**
 * Wiki links are written verbatim. Left as ordinary text they would come back
 * escaped — `\[\[Note]]` — the moment their paragraph was edited.
 */
const writeWikiLink: NonNullable<NonNullable<StringifyOptions['handlers']>['wikiLink']> = (
  node,
  _,
  state,
) =>
  // A pipe in a table cell would end the cell: there the alias's is written `\|`,
  // which the link's syntax reads back as its pipe (`wiki-link-syntax.ts`).
  state.stack.includes('tableCell') ? node.value.replace(/\|/g, '\\|') : node.value;

const writeCalloutMarker: NonNullable<
  NonNullable<StringifyOptions['handlers']>['calloutMarker']
> = (node) => node.value;

const writeVerbatimInline: NonNullable<
  NonNullable<StringifyOptions['handlers']>['verbatimInline']
> = (node) => node.value;

const writeTag: NonNullable<NonNullable<StringifyOptions['handlers']>['tag']> = (node) =>
  node.value;

/**
 * A blank line between a paragraph and a list that could not start straight
 * after it (A21-03). A list may interrupt a paragraph only when its first item
 * is not empty and, if numbered, starts at 1: a lone `-` under a line of text
 * underlines it as a heading, and `3.` carries on the paragraph.
 */
const listAfterParagraph: Join = (left, right) => {
  if (left.type !== 'paragraph' || right.type !== 'list') return undefined;
  const [first] = right.children;
  const empty = (first?.children ?? []).every(
    (child) => child.type === 'paragraph' && child.children.length === 0,
  );
  const numbered = right.ordered === true && (right.start ?? 1) !== 1;
  return empty || numbered ? 1 : undefined;
};

/**
 * The markers a list is written with. Two lists side by side at the top of a
 * note are one list to markdown, blank line or not, unless their markers
 * differ: a list written next to another is given the markers its neighbours
 * do not use (A21-03). Inside a block remark does this itself.
 */
export interface ListMarkers {
  readonly bullet: '-' | '*' | '+';
  readonly ordered: '.' | ')';
}

export const DEFAULT_MARKERS: ListMarkers = { bullet: '-', ordered: '.' };

/** GFM's own options as the editor writes it: cells are not padded out to a common width. */
export const GFM_WRITE_OPTIONS = { tablePipeAlign: false } as const;

/**
 * The settings every block is written with, for the list markers it is
 * given, but for images: the editor adds its image handler
 * (`markdown-blocks.ts`), which needs the domain's image rules, and a
 * capture holds no image, so its bundle for n8n stays free of them.
 */
export function stringifySettings({ bullet, ordered }: ListMarkers): StringifyOptions {
  return {
    bullet,
    bulletOther: bullet === '*' ? '-' : '*',
    bulletOrdered: ordered,
    emphasis: '*',
    strong: '*',
    fence: '`',
    fences: true,
    rule: '-',
    listItemIndent: 'one',
    // Remark writes a link whose text is its address as `<address>`, but an
    // address GFM finds in text is not always one `<…>` holds: `a@b.c_d` is
    // not an email there, and in a table cell a `|` in it ends the cell
    // (A21-04). A link is written `[text](address)`; one typed as a bare
    // address is still written bare (`writeTypedAddressesBare`), and one
    // written `<…>` keeps its bytes (`keepWrittenInlines`).
    resourceLink: true,
    // Remark writes an address that starts with `<` bare, `(<x>)`, which reads
    // back as the address `x`; escaped, `(\\<x>)`, it reads as written.
    unsafe: [
      { character: '<', inConstruct: 'destinationRaw' },
      // GFM links `www.` whatever follows it, and the link runs on over any
      // escape after it: `www.\~\~k` lost its backslashes, `www.@*\</b>` its
      // HTML. Remark escapes the dot only before a letter, digit, `-` or `.`.
      // Escaped always, where it is text; A21-01 takes the escape off again
      // wherever that reads the same.
      {
        character: '.',
        before: '[Ww]{3}',
        inConstruct: 'phrasing',
        notInConstruct: ['autolink', 'destinationLiteral', 'destinationRaw', 'reference'],
      },
      // Text that ends a paragraph or an item as ` ^abc` reads back as its
      // block id (P26-01), so a caret typed there is escaped: `mc \^2`.
      // It is written bare wherever that reads the same (A21-01).
      {
        character: '^',
        before: '(?:^|[ \\t\\r\\n])',
        after: '[A-Za-z0-9-]+[ \\t]*(?:$|[\\r\\n])',
        inConstruct: 'phrasing',
      },
      // An email autolink, `<**`a@b.co>`, may start with any character an
      // address's name may hold, not only the letters remark escapes `<`
      // before: bold `x<` then code `a@b.co>` read back as a link (A21-04).
      {
        character: '<',
        after: "[\\w.!#$%&'*+/=?^`{|}~-]",
        inConstruct: 'phrasing',
        notInConstruct: [
          'autolink',
          'destinationLiteral',
          'destinationRaw',
          'reference',
          'titleQuote',
          'titleApostrophe',
        ],
      },
    ],
    join: [listAfterParagraph],
    handlers: {
      wikiLink: writeWikiLink,
      calloutMarker: writeCalloutMarker,
      verbatimInline: writeVerbatimInline,
      tag: writeTag,
      delete: writeDelete,
      emphasis: writeEmphasis,
      strong: writeStrong,
    },
  };
}

/**
 * Remark encodes the character beside a `**` or `*` when it must, but by one
 * UTF-16 unit, so an emoji there was written half as a reference and half as
 * itself, and read back as garbage. Each such pair is made one reference.
 */
export function wholeCharacterReferences(markdown: string): string {
  const unit = (text: string) =>
    text.startsWith('&') ? Number.parseInt(text.slice(3, -1), 16) : text.charCodeAt(0);
  return markdown.replace(
    /(&#xD[89AB][0-9A-F]{2};|[\uD800-\uDBFF])(&#xD[C-F][0-9A-F]{2};|[\uDC00-\uDFFF])/gi,
    (whole: string, high: string, low: string) => {
      if (!high.startsWith('&') && !low.startsWith('&')) return whole;
      const pair = String.fromCharCode(unit(high), unit(low));
      return `&#x${pair.codePointAt(0)!.toString(16).toUpperCase()};`;
    },
  );
}
