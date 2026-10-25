import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import {
  BLOCK_ANCHOR_ATTR,
  BLOCK_ID_ATTR,
  anchorStyleOf,
  blockAnchorSuffix,
  blockAnchorsOf,
  blockIdOf,
  standaloneBlockAnchor,
  withAnchorsAtPlaces,
  withoutAnchorAttr,
  withoutBlockAnchors,
  type EditorDocument,
  type EditorNode,
  type ParsedBody,
  type SourceBlock,
} from '@dfai/domain';
import type { Nodes, Root, RootContent } from 'mdast';
import type { Options as StringifyOptions } from 'remark-stringify';
import type { Join } from 'mdast-util-to-markdown';
import './mdast-custom-nodes.ts';
import { mdastBlockToEditorNode } from './mdast-to-editor.ts';
import { editorNodeToMdastBlock } from './editor-to-mdast.ts';
import { escapesATag } from './escaped-tags.ts';
import { writeAsTyped, type ReadMarkdown } from './as-typed.ts';
import { readingOf } from './reading.ts';
import { bookmarkFromMdast } from './bookmark-block.ts';
import { shownBlockOr } from './block-embed.ts';
import { queryBlockFromMdast } from './query-block.ts';
import { anchoredParagraph, anchorSlots } from './block-anchors.ts';
import { remarkWikiLink } from './wiki-link-syntax.ts';
import { expressible } from './expressible.ts';
import { writeDelete } from './strikethrough-handler.ts';
import { writeEmphasis, writeStrong } from './emphasis-handlers.ts';
import { keepReferences, referencesIn, type WrittenReferences } from './written-references.ts';

/** A block whose markdown the editor does not model. Shown as source, saved verbatim. */
export const RAW_BLOCK = 'rawBlock';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkWikiLink);

/**
 * Wiki links are written verbatim. Left as ordinary text they would come back
 * escaped — `\[\[Note]]` — the moment their paragraph was edited.
 */
const writeWikiLink: NonNullable<StringifyOptions['handlers']>['wikiLink'] = (node, _, state) =>
  // A pipe in a table cell would end the cell: there the alias's is written `\|`,
  // which the link's syntax reads back as its pipe (`wiki-link-syntax.ts`).
  state.stack.includes('tableCell') ? node.value.replace(/\|/g, '\\|') : node.value;

const writeCalloutMarker: NonNullable<StringifyOptions['handlers']>['calloutMarker'] = (node) =>
  node.value;

const writeVerbatimInline: NonNullable<StringifyOptions['handlers']>['verbatimInline'] = (node) =>
  node.value;

const writeTag: NonNullable<StringifyOptions['handlers']>['tag'] = (node) => node.value;

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
interface ListMarkers {
  readonly bullet: '-' | '*' | '+';
  readonly ordered: '.' | ')';
}

const DEFAULT_MARKERS: ListMarkers = { bullet: '-', ordered: '.' };

const stringifiers = new Map<string, ReturnType<typeof stringifierWith>>();

function stringifierFor(markers: ListMarkers) {
  const key = `${markers.bullet}${markers.ordered}`;
  let stringifier = stringifiers.get(key);
  if (stringifier === undefined) {
    stringifier = stringifierWith(markers);
    stringifiers.set(key, stringifier);
  }
  return stringifier;
}

const stringifierWith = ({ bullet, ordered }: ListMarkers) =>
  unified()
    // Cells are not padded out to a common width: a one-character edit would
    // otherwise reflow every row of the table.
    .use(remarkGfm, { tablePipeAlign: false })
    .use(remarkStringify, {
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
    });

const render = (root: Root, markers: ListMarkers = DEFAULT_MARKERS): string =>
  wholeCharacterReferences(stringifierFor(markers).stringify(root).replace(/\n+$/, ''));

/**
 * Remark encodes the character beside a `**` or `*` when it must, but by one
 * UTF-16 unit, so an emoji there was written half as a reference and half as
 * itself, and read back as garbage. Each such pair is made one reference.
 */
function wholeCharacterReferences(markdown: string): string {
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

/** A block as remark writes it, every escape in place, with `written` images as their bytes. */
function renderSafely(
  node: EditorNode,
  written: readonly WrittenInline[] = [],
  markers: ListMarkers = DEFAULT_MARKERS,
): string {
  const { inner, suffix } = lineAnchorOf(node);
  if (inner.type === RAW_BLOCK) return rawWithId(String(inner.attrs?.['markdown'] ?? ''), suffix);
  const root = mdastOf(inner);
  keepWrittenInlines(
    root,
    written.filter((inline) => inline.kind === 'image'),
  );
  return `${render(root, markers)}${suffix}`;
}

/**
 * Markdown the editor does not model, and its id's line after it — unless
 * the markdown runs on over anything after it (a comment or HTML left
 * open), where the id would be swallowed as its text: such a block has no
 * place for an id, and is written as it is.
 */
function rawWithId(markdown: string, suffix: string): string {
  if (suffix === '') return markdown;
  const written = `${markdown}${suffix}`;
  const read = readBlocks(parseBodyToMdast(written), written);
  return read.length === 1 && read[0]?.lineAnchor !== null ? written : markdown;
}

/**
 * A block that carries its id on a line after it (P26-01) — a table, a
 * quote, code — apart from that line: the block as it is written, and the
 * line to write after it. Any other block is itself, with nothing after it.
 */
function lineAnchorOf(node: EditorNode): { inner: EditorNode; suffix: string } {
  const id = node.attrs?.[BLOCK_ANCHOR_ATTR];
  if (anchorStyleOf(node) !== 'line' || typeof id !== 'string' || id === '') {
    return { inner: node, suffix: '' };
  }
  const attrs = withoutAnchorAttr(node.attrs ?? {});
  return { inner: { ...node, attrs }, suffix: blockAnchorSuffix(id, 'line') };
}

const mdastOf = (node: EditorNode): Root => ({
  type: 'root',
  children: [editorNodeToMdastBlock(node) as never],
});

/** What else decides how a block is written, besides the editor's node. */
interface BlockContext {
  /** How the block was written before it was edited, if it was (`writtenIn`). */
  readonly written?: Written;
  /** The note's link definitions, which decide whether `[x]` in text needs escaping. */
  readonly definitions?: readonly LinkDefinition[];
  /** The markers a list is written with, set by the blocks beside it. */
  readonly markers?: ListMarkers;
}

/**
 * Serializes one block to markdown, without a trailing newline, as close to
 * what was typed as reads the same (A21-01). An image or a link that reads the
 * same as one the block was written with is put back as those bytes, rather
 * than in remark's equivalent form (ADR-0003), and so is a reference such as
 * `&amp;` (A21-03).
 */
export function renderBlock(node: EditorNode, context: BlockContext = {}): string {
  const { inner, suffix } = lineAnchorOf(node);
  return `${renderBlockAlone(inner, context)}${suffix}`;
}

function renderBlockAlone(
  node: EditorNode,
  { written = NOTHING_WRITTEN, definitions = [], markers = DEFAULT_MARKERS }: BlockContext,
): string {
  const safe = renderSafely(node, written.inlines, markers);
  if (node.type === RAW_BLOCK) return safe;
  const root = mdastOf(node);
  keepWrittenInlines(root, [...written.inlines]);
  keepReferences(root, written.references);
  writeTypedAddressesBare(root);
  const typed = writeAsTyped({
    safe,
    typed: render(root, markers),
    document: readingOf([expressible(node)]),
    read: (markdown) => readBlock(markdown, definitions),
  });
  // Alone, `^abc` reads as text; after a table it is the table's id (P26-01).
  // Read alone to be checked, it cannot tell which, so it is always escaped.
  const looksLikeAnId = node.type === 'paragraph' && standaloneBlockAnchor(typed) !== null;
  return looksLikeAnId ? `\\${typed}` : typed;
}

/**
 * Parses a block's markdown with the definitions it could refer to after it,
 * so that `[x]` reads as it would in the note.
 */
function readBlock(markdown: string, definitions: readonly LinkDefinition[]): ReadMarkdown {
  const referred = definitions.filter((definition) => mayReferTo(markdown, definition));
  const body = [markdown, ...referred.map((definition) => definition.markdown)].join('\n\n');
  const root = parseBodyToMdast(body);
  const own = root.children.filter(
    (child) => (child.position?.start.offset ?? 0) < markdown.length,
  );
  return { root, reading: readingOf(own.map((child) => editorNodeFor(child, body))) };
}

/** A link or footnote definition in the note: its label, and its own markdown. */
export interface LinkDefinition {
  readonly label: string;
  readonly markdown: string;
}

/**
 * Whether `markdown` could hold a reference to `definition`. Labels match
 * without regard to case or runs of whitespace; one that lower-casing may not
 * fold (anything beyond ASCII) is always taken to match.
 */
function mayReferTo(markdown: string, { label }: LinkDefinition): boolean {
  // eslint-disable-next-line no-control-regex -- every character outside ASCII
  if (/[^\x00-\x7f]/.test(label)) return true;
  const folded = (value: string) => value.toLowerCase().replace(/\s+/g, ' ');
  return folded(markdown).includes(folded(label));
}

/**
 * The note's link and footnote definitions, parsed once. The editor never
 * holds one, so each is in one of its raw blocks.
 */
function definitionsIn(nodes: readonly EditorNode[]): LinkDefinition[] {
  const body = nodes
    .filter((node) => node.type === RAW_BLOCK)
    .map((node) => String(node.attrs?.['markdown'] ?? ''))
    .filter((markdown) => markdown.includes(']:'))
    .join('\n\n');
  if (body === '') return [];
  const found: LinkDefinition[] = [];
  const visit = (node: Nodes) => {
    if (node.type === 'definition' || node.type === 'footnoteDefinition') {
      const start = node.position?.start.offset ?? 0;
      const end = node.position?.end.offset ?? body.length;
      found.push({ label: node.label ?? node.identifier, markdown: body.slice(start, end) });
    } else if ('children' in node) (node.children as Nodes[]).forEach(visit);
  };
  visit(parseBodyToMdast(body));
  return found;
}

/**
 * Writes each link whose text is its own address — `julie@example.com` for
 * `mailto:julie@example.com` — as that bare text, where GFM reads it back as
 * the same link. Whether it does is for `writeAsTyped` to check.
 */
function writeTypedAddressesBare(node: Nodes, inCell = false): void {
  if (!('children' in node)) return;
  const children = node.children as Nodes[];
  children.forEach((child, index) => {
    if (child.type !== 'link') {
      writeTypedAddressesBare(child, inCell || child.type === 'tableCell');
      return;
    }
    const [only] = child.children;
    const text = child.children.length === 1 && only?.type === 'text' ? only.value : '';
    if (text !== '' && !child.title && child.url.endsWith(text))
      children[index] = {
        type: 'verbatimInline',
        value: inCell && text.includes('|') ? escapedForCell(text) : text,
      };
  });
}

/**
 * An address with a `|` in it, as a table cell can hold it (A21-03). The `|`
 * must be escaped or it ends the cell, but GFM finds an address typed bare
 * before escapes are read and runs it on over the backslash: `http://a.b\\|c`
 * links to `http://a.b\\|c`. So the address is not left for that to find — its
 * `://` and `www.` are escaped too — and GFM finds it afterwards instead, in
 * the cell's text, `|` and all, as it did when the note was read.
 */
const escapedForCell = (address: string): string =>
  address
    .replace(/\|/g, '\\|')
    .replace(/:\/\//, '\\://')
    .replace(/^(www)\./i, '$1\\.');

/** An image or link as a block wrote it: what it reads as, and the bytes it was written with. */
interface WrittenInline {
  readonly kind: 'image' | 'link';
  readonly reads: string;
  readonly source: string;
}

/**
 * What an image or a link reads as. A link reads as it would be written
 * afresh, which covers its address, title and text alike.
 */
function inlineReading(node: Nodes): string | null {
  if (node.type === 'image')
    return JSON.stringify([node.url, node.alt ?? null, node.title ?? null]);
  if (node.type !== 'link') return null;
  return render({ type: 'root', children: [{ type: 'paragraph', children: [node] }] });
}

/** How a block was written before it was edited: what of it to write the same way again. */
interface Written {
  readonly inlines: readonly WrittenInline[];
  readonly references: WrittenReferences;
}

const NOTHING_WRITTEN: Written = { inlines: [], references: new Map() };

/** How `source` wrote `block`, from one parse of it. */
function writtenIn(source: string, block: EditorNode): Written {
  const root = parser.parse(source) as Root;
  return { inlines: writtenInlines(root, source, block), references: referencesIn(root, source) };
}

/**
 * Every image and link in a block's markdown, in order, with its own bytes.
 * One that runs over a line break is left out when the block is a container:
 * its bytes carry the container's markers (`> `, an indent), which spliced
 * into the rewritten block would be read again as markup.
 */
function writtenInlines(root: Root, source: string, block: EditorNode): WrittenInline[] {
  const multiLineFits = block.type === 'paragraph';
  const found: WrittenInline[] = [];
  const visit = (node: Nodes) => {
    const reads = inlineReading(node);
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (reads !== null && start !== undefined && end !== undefined) {
      const bytes = source.slice(start, end);
      if (multiLineFits || !bytes.includes('\n'))
        found.push({ kind: node.type === 'image' ? 'image' : 'link', reads, source: bytes });
    }
    if ('children' in node) for (const child of node.children as Nodes[]) visit(child);
  };
  visit(root);
  return found;
}

/**
 * Swaps each image or link in `node` that reads the same as one still in
 * `written` for that one's bytes, using each at most once. One whose address,
 * text or title was changed matches none, and is written afresh.
 */
function keepWrittenInlines(node: Nodes, written: WrittenInline[]): void {
  if (!('children' in node) || written.length === 0) return;
  const children = node.children as Nodes[];
  children.forEach((child, index) => {
    const reads = inlineReading(child);
    const at = reads === null ? -1 : written.findIndex((inline) => inline.reads === reads);
    if (at < 0) {
      keepWrittenInlines(child, written);
      return;
    }
    const [inline] = written.splice(at, 1);
    children[index] = { type: 'verbatimInline', value: inline!.source };
  });
}

/**
 * Splits a note body into top-level blocks, remembering exactly where each came
 * from. The source ranges are what later allow an untouched block to be written
 * back byte for byte.
 */
/** The markdown syntax tree for a note body, shared by the block parser and search. */
export function parseBodyToMdast(body: string): Root {
  if (!body.startsWith(BYTE_ORDER_MARK)) return parser.parse(body) as Root;
  // The parser drops a leading byte-order mark and counts offsets without it;
  // every offset here is into `body`, the mark included (A21-04).
  const root = parser.parse(body.slice(BYTE_ORDER_MARK.length)) as Root;
  shiftOffsets(root, BYTE_ORDER_MARK.length);
  return root;
}

const BYTE_ORDER_MARK = '﻿';

function shiftOffsets(node: Nodes, by: number): void {
  const { position } = node;
  if (position?.start.offset !== undefined) position.start.offset += by;
  if (position?.end.offset !== undefined) position.end.offset += by;
  if ('children' in node) for (const child of node.children as Nodes[]) shiftOffsets(child, by);
}

export function parseMarkdownBody(body: string): ParsedBody {
  const blocks: SourceBlock[] = [];
  const nodes: EditorNode[] = [];

  readBlocks(parseBodyToMdast(body), body).forEach((read, index) => {
    const { child, start, end, node, lineAnchor } = read;
    const id = `b${index}`;
    // Only compared with the block as it is saved, to tell whether it changed:
    // remark's own rendering does that without a parse, so reading a note costs one.
    const normalized = renderSafely(node);
    const hasIds = blockAnchorsOf(node).some((anchor) => anchor !== null);
    blocks.push({
      id,
      index,
      source: body.slice(start, end),
      start,
      end,
      normalized,
      anchors: anchorSlots({ child, node, body, end: read.contentEnd, lineAnchor }),
      bare: hasIds ? renderSafely(withoutBlockAnchors(node)) : normalized,
    });
    nodes.push({ ...node, attrs: { ...node.attrs, [BLOCK_ID_ATTR]: id } });
  });

  return { blocks, doc: { type: 'doc', content: nodes } };
}

/** A top-level block as read, with the id on a line after it, if one was. */
interface ReadBlock {
  readonly child: RootContent;
  readonly start: number;
  /** Where the block ends, its id's line included. */
  end: number;
  /** Where its own markdown ends, before any id's line. */
  readonly contentEnd: number;
  node: EditorNode;
  lineAnchor: { readonly id: string; readonly end: number } | null;
}

/**
 * The body's top-level blocks. A paragraph that is only `^id`, after a block
 * that carries its id on a line of its own, is that block's id (P26-01) and
 * part of its bytes; after anything else it is the paragraph it is.
 */
function readBlocks(root: Root, body: string): ReadBlock[] {
  const read: ReadBlock[] = [];
  for (const child of root.children) {
    const start = child.position?.start.offset ?? 0;
    const end = child.position?.end.offset ?? body.length;
    const previous = read.at(-1);
    const id = child.type === 'paragraph' ? standaloneBlockAnchor(body.slice(start, end)) : null;
    if (id !== null && previous !== undefined && takesLineAnchor(previous)) {
      const attrs = { ...previous.node.attrs, [BLOCK_ANCHOR_ATTR]: id };
      previous.node = { ...previous.node, attrs };
      previous.lineAnchor = { id, end };
      previous.end = end;
      continue;
    }
    const node = editorNodeFor(child, body);
    read.push({ child, start, end, contentEnd: end, node, lineAnchor: null });
  }
  return read;
}

const takesLineAnchor = (read: ReadBlock): boolean =>
  read.lineAnchor === null && anchorStyleOf(read.node) === 'line';

/** A top-level block as the editor holds it, or as its source when the editor cannot. */
function editorNodeFor(child: RootContent, body: string): EditorNode {
  const converted = escapesATag(child, body)
    ? null
    : (bookmarkFromMdast(child, body) ??
      queryBlockFromMdast(child) ??
      shownBlockOr(mdastBlockToEditorNode(child, body)));
  if (
    (converted?.type === 'paragraph' && child.type === 'paragraph') ||
    (converted?.type === 'heading' && child.type === 'heading')
  ) {
    return anchoredParagraph(converted, child, body);
  }
  if (converted !== null) return converted;
  const start = child.position?.start.offset ?? 0;
  const end = child.position?.end.offset ?? body.length;
  return { type: RAW_BLOCK, attrs: { markdown: body.slice(start, end) } };
}

/**
 * Writes the document back to markdown, reusing the original bytes of every block
 * the user did not change — including the whitespace between them. A block counts
 * as unchanged when it serializes to what it serialized to when it was loaded, so
 * editing one paragraph rewrites one paragraph and nothing else.
 */
export function serializeMarkdownBody({
  originalBody,
  parsed,
  doc,
}: {
  originalBody: string;
  parsed: ParsedBody;
  doc: EditorDocument;
}): string {
  const byId = new Map(parsed.blocks.map((block) => [block.id, block]));
  // The editor keeps an empty paragraph at the end so there is somewhere to type
  // after an atom block. Markdown has no such thing, so blocks that serialize to
  // nothing are dropped rather than written out as stray blank lines. Only
  // markdown's own whitespace counts as nothing: a no-break space is what an
  // `&nbsp;` spacer paragraph holds, and it is kept (A21-04).
  // Each id is written where the file has a place for it (`withAnchorsAtPlaces`):
  // one the editor holds inside a block — a paragraph made a list item keeps its
  // own — is that block's, whether the block is written afresh or spliced.
  const nodes = doc.content
    .map(withAnchorsAtPlaces)
    .filter((node) => /[^ \t\r\n]/.test(renderSafely(node)));

  if (nodes.length === 0) return parsed.blocks.length === 0 ? originalBody : '';

  const pieces: string[] = [];
  let previous: SourceBlock | null = null;
  let previousText = '';
  // The definitions the saved note will hold: parsed once, and only once a block has changed.
  let definitions: readonly LinkDefinition[] | undefined;
  const definitionsOfNote = () => (definitions ??= definitionsIn(nodes));
  const lineEnding = lineEndingOf(originalBody);
  // Each block's own bytes where it was not changed — or was changed only in
  // its ids, which are spliced into those bytes (P26-01).
  const kept = nodes.map((node) => {
    const block = byId.get(blockIdOf(node) ?? '') ?? null;
    if (block === null) return null;
    if (renderSafely(node) === block.normalized) return block.source;
    return withIdsSpliced(node, block, lineEnding);
  });

  nodes.forEach((node, index) => {
    const block = byId.get(blockIdOf(node) ?? '') ?? null;
    const keptText = kept[index] ?? null;
    const beforeNode = index === 0 ? null : (nodes[index - 1] ?? null);
    // A kept list that now stands after another with its markers is written again
    // with other ones, or the two read back as one list (`listsWouldJoin`). An id
    // on a line between them already keeps them apart.
    const joinsBefore =
      keptText !== null && !endsWithLineId(beforeNode) && listsWouldJoin(previousText, keptText);
    const unchanged = keptText !== null && !joinsBefore;
    const next = kept[index + 1] ?? '';
    const text = unchanged
      ? keptAfter(beforeNode, node, keptText)
      : withLineEnding(
          renderBlock(node, {
            written: block === null ? NOTHING_WRITTEN : writtenIn(block.source, node),
            definitions: definitionsOfNote(),
            markers: markersBeside(previousText, next),
          }),
          lineEnding,
        );

    if (index === 0) {
      // Whatever precedes the first block — the blank line after frontmatter, say —
      // belongs to the document rather than to the block, so it is kept even when
      // that first block is the one being edited.
      pieces.push(originalBody.slice(0, parsed.blocks[0]?.start ?? 0));
    } else {
      const original = separatorBetween({ originalBody, previous, block, unchanged });
      // An id on a line of its own must be followed by a blank line, or it runs
      // into the block after it: `^id` then `next` is one paragraph (P26-01).
      const blank = `${lineEnding}${lineEnding}`;
      const runsOn = endsWithLineId(beforeNode) && original !== null && !isBlankLine(original);
      pieces.push(original === null || runsOn ? blank : original);
    }

    pieces.push(text);
    previous = unchanged ? block : null;
    previousText = text;
  });

  pieces.push(trailing({ originalBody, parsed, previous, nodes }) ?? lineEnding);
  return pieces.join('');
}

/** Whether `node` is written with its id on a line of its own after it. */
function endsWithLineId(node: EditorNode | null): boolean {
  const id = node?.attrs?.[BLOCK_ANCHOR_ATTR];
  return node !== null && anchorStyleOf(node) === 'line' && typeof id === 'string' && id !== '';
}

/** Whether a separator between two blocks holds a blank line. */
const isBlankLine = (separator: string): boolean => /\n[ \t]*\r?\n/.test(separator);

/**
 * A kept block's bytes where it now stands. A paragraph that is only `^abc`,
 * left untouched, comes to stand after a table or a list with no id when the
 * blocks around it change — where it would be read as that block's id — and
 * is escaped there, so it reads back as the text it is (P26-01).
 */
function keptAfter(before: EditorNode | null, node: EditorNode, text: string): string {
  const takesAnId = before !== null && anchorStyleOf(before) === 'line' && !endsWithLineId(before);
  return node.type === 'paragraph' && takesAnId && standaloneBlockAnchor(text) !== null
    ? `\\${text}`
    : text;
}

/**
 * A block's own bytes with only its ids changed: each id added, changed or
 * taken off where `block.anchors` says it goes, and every other byte as it
 * was. Null when more than its ids changed, or its ids' places are unknown.
 */
function withIdsSpliced(
  node: EditorNode,
  block: SourceBlock,
  lineEnding: '\n' | '\r\n',
): string | null {
  const slots = block.anchors;
  const ids = blockAnchorsOf(node);
  if (slots === null || slots === undefined || ids.length !== slots.length) return null;
  if (renderSafely(withoutBlockAnchors(node)) !== block.bare) return null;
  const { source, start } = block;
  const pieces: string[] = [];
  let at = start;
  slots.forEach((slot, index) => {
    const id = ids[index] ?? null;
    pieces.push(source.slice(at - start, slot.start - start));
    if (id === slot.id) pieces.push(source.slice(slot.start - start, slot.end - start));
    else if (id !== null) pieces.push(blockAnchorSuffix(id, slot.style, lineEnding));
    at = slot.end;
  });
  pieces.push(source.slice(at - start));
  const spliced = pieces.join('');
  return readsAsSpliced(spliced, block, ids) ? spliced : null;
}

/**
 * Whether the block's bytes with its ids spliced in read back as the block
 * with those ids, and nothing else. They do not always: a fence or a comment
 * left open runs on over an id after it, and `- [ ] ^q1` turns words `[ ]`
 * into a checkbox. Such a block is written afresh instead.
 */
function readsAsSpliced(
  spliced: string,
  block: SourceBlock,
  ids: readonly (string | null)[],
): boolean {
  const [read, ...more] = readBlocks(parseBodyToMdast(spliced), spliced);
  if (read === undefined || more.length > 0) return false;
  const reread = blockAnchorsOf(read.node);
  return (
    renderSafely(withoutBlockAnchors(read.node)) === block.bare &&
    reread.length === ids.length &&
    reread.every((id, index) => id === ids[index])
  );
}

/**
 * The line ending the note is written with: its first one, so a file saved
 * on Windows keeps its `\r\n` in the blocks that are rewritten (A21-03).
 */
function lineEndingOf(body: string): '\n' | '\r\n' {
  const first = body.indexOf('\n');
  return first > 0 && body[first - 1] === '\r' ? '\r\n' : '\n';
}

/** `text`, written by remark with `\n`, with the note's own line ending instead. */
const withLineEnding = (text: string, lineEnding: string): string =>
  lineEnding === '\n' ? text : text.replace(/\r?\n/g, lineEnding);

const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

type ListMarker = ListMarkers['bullet'] | ListMarkers['ordered'];

/** The marker a block's first line makes it an item with — a bullet, or a number's delimiter — or null. */
function listMarkerOf(text: string): ListMarker | null {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  // `- - -` and `* * *` are separators, not lists (A21-04).
  if (THEMATIC_BREAK.test(line)) return null;
  const match = /^ {0,3}(?:\d{1,9}([.)])|([-*+]))(?:[ \t]|$)/.exec(line);
  return match === null ? null : ((match[2] ?? match[1]) as ListMarker);
}

/**
 * Whether `after`, written straight after `before`, would read as more of the
 * same list: both begin as items with one marker. Two kept lists come to
 * stand so when the block between them is moved or deleted (#569); the one
 * after is then written again with the markers the one before does not use,
 * so the note reads back as the two lists the person sees, each with its id.
 */
const listsWouldJoin = (before: string, after: string): boolean => {
  const marker = listMarkerOf(before);
  return marker !== null && marker === listMarkerOf(after);
};

/** The list markers neither neighbour's first line is written with (`ListMarkers`). */
function markersBeside(before: string, after: string): ListMarkers {
  const beside = [listMarkerOf(before), listMarkerOf(after)];
  // Every marker of a kind beside it (three numbered lists in a row): the one before
  // is written already, so its marker is the one to avoid; the one after is written
  // again in its turn if it then joins.
  const free = <Marker extends ListMarker>(all: readonly Marker[]): Marker =>
    all.find((marker) => !beside.includes(marker)) ?? all.find((marker) => marker !== beside[0])!;
  return { bullet: free(['-', '*', '+']), ordered: free(['.', ')']) };
}

function separatorBetween({
  originalBody,
  previous,
  block,
  unchanged,
}: {
  originalBody: string;
  previous: SourceBlock | null;
  block: SourceBlock | null;
  unchanged: boolean;
}): string | null {
  // Null: a blank line, written with the note's own line ending.
  // The original whitespace may only be reused when these two blocks were
  // neighbours in the original too. Checking offsets alone would splice back in
  // whatever sat between them — including a block the user just deleted.
  const stillAdjacent = previous !== null && block !== null && block.index === previous.index + 1;
  if (stillAdjacent && unchanged) {
    return originalBody.slice(previous.end, block.start);
  }
  return null;
}

function trailing({
  originalBody,
  parsed,
  previous,
  nodes,
}: {
  originalBody: string;
  parsed: ParsedBody;
  previous: SourceBlock | null;
  nodes: readonly EditorNode[];
}): string | null {
  const lastOriginal = parsed.blocks.at(-1);
  const keptTheEnding =
    previous !== null && lastOriginal !== undefined && previous.id === lastOriginal.id;
  if (keptTheEnding) return originalBody.slice(lastOriginal.end);
  // A note ends with exactly one line ending (null) unless its original ending was preserved.
  return nodes.length === 0 ? '' : null;
}
