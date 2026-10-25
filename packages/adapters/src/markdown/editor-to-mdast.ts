import {
  BLOCK_ANCHOR_ATTR,
  BLOCK_EMBED_NODE,
  BOOKMARK_NODE,
  findTags,
  formatCalloutMarker,
  formatWikiLink,
  nestedBlockOf,
  QUERY_BLOCK_NODE,
  type EditorMark,
  type ImageSize,
  type EditorNode,
} from '@dfai/domain';
import { imageWithAlt } from './image-alt.ts';
import type { BlockContent, Nodes as MdastNode, PhrasingContent } from 'mdast';
import './mdast-custom-nodes.ts';
import { bookmarkToMdast } from './bookmark-block.ts';
import { embedToMdast } from './block-embed.ts';
import { queryBlockToMdast } from './query-block.ts';
import { expressible } from './expressible.ts';

/**
 * Outermost first. Marks nest in this order so that adjacent text sharing a mark
 * produces one `**run**` rather than `**a****b**`. `code` is absent because
 * inline code has no children in markdown; it is handled at the leaf.
 */
const MARK_ORDER = ['link', 'bold', 'italic', 'strike'] as const;

export class UnsupportedNodeError extends Error {
  /** `where`: the place markdown has no way to write such a node, when it has one elsewhere. */
  constructor(type: string, where?: string) {
    super(
      `Cannot serialize editor node of type "${type}"${where === undefined ? '' : ` ${where}`}`,
    );
    this.name = 'UnsupportedNodeError';
  }
}

/** A block as markdown, written as markdown can hold it (`expressible`). */
export function editorNodeToMdastBlock(node: EditorNode): MdastNode {
  const written = expressible(node);
  const mdast = blockToMdast(written);
  // A paragraph or a heading of the note's own ends with its id (P26-01,
  // A26-01); one anywhere else takes none (`withAnchorsAtPlaces`).
  return withAnchor(mdast, anchorOf(written));
}

/** The node's block id, or null. */
function anchorOf(node: EditorNode): string | null {
  const id = node.attrs?.[BLOCK_ANCHOR_ATTR];
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * A paragraph or a heading with its block id written after its text, as it is
 * read back (`trailingBlockAnchor`), or as it was when it has none or no text
 * to follow.
 */
function withAnchor<Block extends MdastNode>(
  paragraph: Block,
  id: string | null,
  { afterBox = false }: { afterBox?: boolean } = {},
): Block {
  if (id === null || (paragraph.type !== 'paragraph' && paragraph.type !== 'heading'))
    return paragraph;
  // A line break that ends a paragraph is dropped by markdown anyway; left
  // before the id, it would put the id on a line of its own.
  const children = [...paragraph.children];
  while (children.at(-1)?.type === 'break') children.pop();
  // An id needs words before it: alone on its line it is a block of its own —
  // but for a task's, which may follow its box alone, `- [ ] ^id`, as
  // Obsidian writes it (A26-01).
  const words = children.some((child) => child.type !== 'text' || child.value.trim() !== '');
  if (words) return { ...paragraph, children: [...children, verbatim(` ^${id}`)] };
  if (!afterBox) return paragraph;
  if (children.length === 0) return { ...paragraph, children: [verbatim(`^${id}`)] };
  // Spaces after the box are read as nothing unless written as references.
  const spaces = children.map((child) => (child.type === 'text' ? child.value : '')).join('');
  return { ...paragraph, children: [verbatim(`${referenced(spaces)} ^${id}`)] };
}

const verbatim = (value: string): PhrasingContent => ({ type: 'verbatimInline', value });

/** Whitespace as character references, which markdown reads as the text they are. */
const referenced = (spaces: string): string =>
  [...spaces].map((space) => `&#x${space.codePointAt(0)!.toString(16).toUpperCase()};`).join('');

function blockToMdast(node: EditorNode): MdastNode {
  switch (node.type) {
    case 'paragraph':
      return { type: 'paragraph', children: phrasing(node.content ?? []) };
    case 'heading': {
      const depth = depthOf(node);
      const content = node.content ?? [];
      return {
        type: 'heading',
        depth,
        children: phrasing(content, [], HTML_BREAK),
      };
    }
    case 'horizontalRule':
      return { type: 'thematicBreak' };
    case 'codeBlock':
      return {
        type: 'code',
        lang: typeof node.attrs?.['language'] === 'string' ? node.attrs['language'] : null,
        value: (node.content ?? []).map((child) => child.text ?? '').join(''),
      };
    case 'blockquote':
      return {
        type: 'blockquote',
        children: (node.content ?? []).map(nestedToMdast),
      };
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listToMdast(node);
    case 'table':
      return tableToMdast(node);
    case 'callout':
      return calloutToMdast(node);
    case BOOKMARK_NODE:
      return bookmarkToMdast(node);
    case BLOCK_EMBED_NODE:
      return embedToMdast(node);
    case QUERY_BLOCK_NODE:
      return queryBlockToMdast(node);
    default:
      throw new UnsupportedNodeError(node.type);
  }
}

/** A block inside another block: a card there is written as its link (`nestedBlockOf`). */
const nestedToMdast = (child: EditorNode): BlockContent =>
  blockToMdast(nestedBlockOf(child)) as BlockContent;

function depthOf(node: EditorNode): 1 | 2 | 3 | 4 | 5 | 6 {
  const level = node.attrs?.['level'];
  return typeof level === 'number' && level >= 1 && level <= 6
    ? (level as 1 | 2 | 3 | 4 | 5 | 6)
    : 1;
}

function listToMdast(node: EditorNode): MdastNode {
  const ordered = node.type === 'orderedList';
  const start = node.attrs?.['start'];
  return {
    type: 'list',
    ordered,
    start: ordered && typeof start === 'number' ? start : null,
    spread: false,
    children: (node.content ?? []).map((item) => {
      const [first, ...rest] = (item.content ?? []).map(nestedToMdast);
      return {
        type: 'listItem' as const,
        spread: false,
        checked: item.type === 'taskItem' ? item.attrs?.['checked'] === true : null,
        // An item's id follows its own first line (P26-01).
        children:
          first === undefined
            ? []
            : [withAnchor(first, anchorOf(item), { afterBox: item.type === 'taskItem' }), ...rest],
      };
    }),
  };
}

function calloutToMdast(node: EditorNode): MdastNode {
  const marker = formatCalloutMarker({
    kind: String(node.attrs?.['kind'] ?? 'note'),
    title: typeof node.attrs?.['title'] === 'string' ? node.attrs['title'] : null,
    fold: typeof node.attrs?.['fold'] === 'string' ? node.attrs['fold'] : null,
  });

  const blocks = (node.content ?? []).map(nestedToMdast);
  const [first, ...rest] = blocks;

  // Fold the marker into the first paragraph so it is written the compact way
  // Obsidian writes it: `> [!note] Title` then the body on the next line.
  const markerNode: PhrasingContent = { type: 'calloutMarker', value: marker };

  if (first?.type === 'paragraph') {
    return {
      type: 'blockquote',
      children: [
        {
          type: 'paragraph',
          children:
            first.children.length === 0
              ? [markerNode]
              : [markerNode, { type: 'text', value: '\n' }, ...first.children],
        },
        ...rest,
      ],
    };
  }

  return {
    type: 'blockquote',
    children: [{ type: 'paragraph', children: [markerNode] }, ...blocks],
  };
}

function tableToMdast(node: EditorNode): MdastNode {
  const align = node.attrs?.['align'];
  return {
    type: 'table',
    align: Array.isArray(align) ? (align as ('left' | 'right' | 'center' | null)[]) : [],
    children: (node.content ?? []).map((row) => ({
      type: 'tableRow' as const,
      children: (row.content ?? []).map((cell) => ({
        type: 'tableCell' as const,
        children: phrasing(cellLine(cell), [], HTML_BREAK),
      })),
    })),
  };
}

/**
 * A cell's content: the one paragraph `expressible` has made of it. A block
 * it kept after that line is one a cell has no way to write (a highlight,
 * raw HTML): the save is refused, loudly, rather than writing nothing (#569).
 */
function cellLine(cell: EditorNode): readonly EditorNode[] {
  const [line, ...rest] = cell.content ?? [];
  const unwritable = line !== undefined && line.type !== 'paragraph' ? line : rest[0];
  if (unwritable !== undefined) {
    throw new UnsupportedNodeError(unwritable.type, 'in a table cell, which holds one line');
  }
  return line?.content ?? [];
}

/** A line break as markdown writes one: a backslash ending the line. */
const BREAK: PhrasingContent = { type: 'break' };

/**
 * A line break where a line cannot end — in a table cell or a heading —
 * written as the HTML Obsidian and GitHub read there, and which the reader
 * reads back as the line break there and nowhere else (`mdast-to-editor.ts`).
 * A heading of every level writes it so (A21-04): remark would underline a
 * level-one or -two heading holding a `break` instead, and a `<br>` typed in
 * one would then be rewritten that way on its first edit.
 */
const HTML_BREAK: PhrasingContent = { type: 'html', value: '<br>' };

function markKey(mark: EditorMark): string {
  return mark.type === 'link' ? `link:${String(mark.attrs?.['href'] ?? '')}` : mark.type;
}

function hasMark(node: EditorNode, key: string): boolean {
  return (node.marks ?? []).some((mark) => markKey(mark) === key);
}

/** Turns a flat run of marked text nodes back into markdown's nested structure. */
function phrasing(
  nodes: readonly EditorNode[],
  applied: readonly string[] = [],
  lineBreak: PhrasingContent = BREAK,
): PhrasingContent[] {
  const result: PhrasingContent[] = [];
  let index = 0;

  while (index < nodes.length) {
    const node = nodes[index];
    if (node === undefined) break;

    const pending = (node.marks ?? []).filter(
      (mark) => mark.type !== 'code' && !applied.includes(markKey(mark)),
    );
    const next = MARK_ORDER.flatMap((type) => pending.filter((mark) => mark.type === type))[0];

    if (next === undefined) {
      const inLink = applied.some((key) => key.startsWith('link:'));
      const written = node.type === 'hardBreak' ? lineBreak : leaf(node);
      result.push(...(inLink ? [written] : withTags(written)).flatMap(withBackslashesEscaped));
      index += 1;
      continue;
    }

    const key = markKey(next);
    let end = index;
    while (end < nodes.length && hasMark(nodes[end] as EditorNode, key)) end += 1;

    const children = phrasing(nodes.slice(index, end), [...applied, key], lineBreak);
    result.push(wrap(next, children));
    index = end;
  }

  return result;
}

function wrap(mark: EditorMark, children: PhrasingContent[]): PhrasingContent {
  switch (mark.type) {
    case 'bold':
      return { type: 'strong', children };
    case 'italic':
      return { type: 'emphasis', children };
    case 'strike':
      return { type: 'delete', children };
    case 'link':
      return {
        type: 'link',
        url: String(mark.attrs?.['href'] ?? ''),
        title: typeof mark.attrs?.['title'] === 'string' ? mark.attrs['title'] : null,
        children,
      };
    default:
      throw new UnsupportedNodeError(mark.type);
  }
}

/**
 * Plain text with each tag in it written verbatim, by a handler: remark would
 * escape a `#` opening a line, and `\\#idea` is no longer a tag (ADR-0004).
 * A link's text is left as text, since a tag there is not read as one.
 */
function withTags(node: PhrasingContent): PhrasingContent[] {
  if (node.type !== 'text') return [node];
  const pieces: PhrasingContent[] = [];
  let cursor = 0;
  for (const tag of findTags(node.value)) {
    if (tag.start > cursor)
      pieces.push({ type: 'text', value: node.value.slice(cursor, tag.start) });
    pieces.push({ type: 'tag', value: node.value.slice(tag.start, tag.end) });
    cursor = tag.end;
  }
  if (cursor < node.value.length) pieces.push({ type: 'text', value: node.value.slice(cursor) });
  return pieces;
}

/**
 * Text with each backslash in it written escaped, `\`. Remark leaves one
 * bare before a letter — `\é` — then may write that letter as `&#xE9;` beside
 * a `**`, and `\&#xE9;` reads as the text `&#xE9;` (A21-03). A21-01 takes
 * off each escape that reads the same without it.
 */
function withBackslashesEscaped(node: PhrasingContent): PhrasingContent[] {
  if (node.type !== 'text' || !node.value.includes('\\')) return [node];
  return node.value
    .split(/(\\)/)
    .filter((piece) => piece !== '')
    .map((piece) =>
      piece === '\\' ? { type: 'verbatimInline', value: '\\\\' } : { type: 'text', value: piece },
    );
}

/** The size an image node is drawn at (#568), written at the end of its alt text; none when unsized. */
function imageSizeOf(node: EditorNode): ImageSize | null {
  const width = node.attrs?.['width'];
  if (typeof width !== 'number' || !Number.isInteger(width) || width <= 0) return null;
  const height = node.attrs?.['height'];
  return { width, height: Number.isInteger(height) && Number(height) > 0 ? Number(height) : null };
}

function leaf(node: EditorNode): PhrasingContent {
  if (node.type === 'image') {
    const alt = typeof node.attrs?.['alt'] === 'string' ? node.attrs['alt'] : null;
    // The size is written after the words by the image's handler (`writeImage`).
    return imageWithAlt(
      {
        type: 'image',
        url: String(node.attrs?.['src'] ?? ''),
        title: typeof node.attrs?.['title'] === 'string' ? node.attrs['title'] : null,
      },
      { alt, size: imageSizeOf(node) },
    );
  }
  if (node.type === 'wikiLink') {
    // Written by a handler on the stringifier, so its brackets are not escaped.
    return {
      type: 'wikiLink',
      value: formatWikiLink({
        target: String(node.attrs?.['target'] ?? ''),
        heading: typeof node.attrs?.['heading'] === 'string' ? node.attrs['heading'] : null,
        alias: typeof node.attrs?.['alias'] === 'string' ? node.attrs['alias'] : null,
        embed: node.attrs?.['embed'] === true,
      }),
    };
  }
  if (node.type !== 'text') throw new UnsupportedNodeError(node.type);
  const text = node.text ?? '';
  return hasMark(node, 'code')
    ? { type: 'inlineCode', value: text }
    : { type: 'text', value: text };
}
