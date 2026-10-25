import {
  BLOCK_ANCHOR_ATTR,
  parseCalloutMarker,
  readWikiLink,
  standaloneBlockAnchor,
  type EditorMark,
  type EditorNode,
} from '@dfai/domain';
import { paragraphAnchor, withoutTrailingAnchor } from './block-anchors.ts';
import { imageAltOf, readImageSizes } from './image-alt.ts';
import type { Nodes as MdastNode, Parent as MdastParent, PhrasingContent } from 'mdast';

/**
 * Converts one top-level markdown block into an editor node.
 *
 * Returns null when the block — or anything nested inside it — uses a construct the
 * editor does not model. The caller then keeps the block's original source instead,
 * so an unsupported construct survives a round trip untouched rather than being
 * approximated and quietly rewritten.
 */
export function mdastBlockToEditorNode(node: MdastNode, body: string): EditorNode | null {
  readImageSizes(node, body);
  switch (node.type) {
    case 'paragraph': {
      const content = inlineContent(node.children);
      return content === null ? null : { type: 'paragraph', content };
    }
    case 'heading': {
      const content = inlineContent(withBreaksRead(node.children));
      return content === null ? null : { type: 'heading', attrs: { level: node.depth }, content };
    }
    case 'thematicBreak':
      return { type: 'horizontalRule' };
    case 'code':
      return {
        type: 'codeBlock',
        attrs: { language: node.lang ?? null },
        // An empty code block has no text node at all; ProseMirror rejects empty text.
        ...(node.value === '' ? {} : { content: [{ type: 'text', text: node.value }] }),
      };
    case 'blockquote':
      return calloutToEditorNode(node, body) ?? plainBlockquote(node, body);
    case 'list':
      return listToEditorNode(node, body);
    case 'table':
      return tableToEditorNode(node);
    default:
      return null;
  }
}

function plainBlockquote(
  node: Extract<MdastNode, { type: 'blockquote' }>,
  body: string,
): EditorNode | null {
  const content = blockChildren(node, body);
  return content === null ? null : { type: 'blockquote', content };
}

/**
 * A blockquote opening with `[!note]` is a callout. The marker lives on the node
 * rather than in the text, so editing the body cannot damage it and the title is
 * not mistaken for content.
 *
 * The title is the rest of the marker's line as written in `body` — links,
 * escapes, references and all — so it is written back byte for byte when only
 * the body is edited (A21-04), whatever the line ending. Markup that runs from
 * the title's line into the body cannot be split between the two: such a
 * callout is kept as its source.
 */
function calloutToEditorNode(
  node: Extract<MdastNode, { type: 'blockquote' }>,
  body: string,
): EditorNode | null {
  const [first, ...remaining] = node.children;
  if (first?.type !== 'paragraph' || first.children[0]?.type !== 'text') return null;
  const start = first.position?.start.offset;
  const end = first.position?.end.offset;
  if (start === undefined || end === undefined) return null;

  const newline = body.indexOf('\n', start);
  const lineEnd = newline === -1 || newline > end ? end : newline;
  const marker = parseCalloutMarker(body.slice(start, lineEnd).replace(/\r$/, ''));
  if (marker === null) return null;

  const content: EditorNode[] = [];
  const afterTitle = inlineAfterLine(first.children, lineEnd);
  if (afterTitle === null) return null;
  if (afterTitle.length > 0) {
    const inline = inlineContent(afterTitle);
    if (inline === null) return null;
    content.push({ type: 'paragraph', content: inline });
  }

  for (const child of remaining) {
    const converted = mdastBlockToEditorNode(child as MdastNode, body);
    if (converted === null) return null;
    content.push(converted);
  }

  return {
    type: 'callout',
    attrs: { kind: marker.kind, title: marker.title, fold: marker.fold },
    // ProseMirror needs at least one child block to put the caret in.
    content: content.length > 0 ? content : [{ type: 'paragraph' }],
  };
}

/**
 * The inline content after the line that ends at `lineEnd`: text running over
 * it is cut after its line break, and a line break there is the line's own
 * end. Null when anything else runs over it.
 *
 * GFM's addresses split a text node into pieces that carry no position; a
 * piece is placed by the line break it holds, or else by what came before it.
 */
function inlineAfterLine(
  children: readonly PhrasingContent[],
  lineEnd: number,
): PhrasingContent[] | null {
  const after: PhrasingContent[] = [];
  let past = false;
  for (const child of children) {
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    const placed = start !== undefined && end !== undefined;
    if (past || (placed && start > lineEnd)) {
      past = true;
      after.push(child);
    } else if (child.type === 'text' && child.value.includes('\n')) {
      past = true;
      const rest = child.value.slice(child.value.indexOf('\n') + 1);
      if (rest !== '') after.push({ type: 'text', value: rest });
    } else if (placed && end > lineEnd) {
      if (child.type !== 'break') return null;
      past = true;
    }
  }
  return after;
}

function blockChildren(parent: MdastParent, body: string): EditorNode[] | null {
  const converted: EditorNode[] = [];
  for (const child of parent.children) {
    const node = mdastBlockToEditorNode(child as MdastNode, body);
    if (node === null) return null;
    converted.push(node);
  }
  return converted;
}

function listToEditorNode(
  list: Extract<MdastNode, { type: 'list' }>,
  body: string,
): EditorNode | null {
  const isTaskList = list.children.some(
    (item) => item.checked !== null && item.checked !== undefined,
  );

  const items: EditorNode[] = [];
  for (const item of list.children) {
    const content = blockChildren(item, body);
    if (content === null) return null;
    const node: EditorNode = isTaskList ? taskItemOf(item, content) : { type: 'listItem', content };
    items.push(anchoredItem(node, item, body));
  }

  if (isTaskList) return { type: 'taskList', content: items };
  return list.ordered === true
    ? { type: 'orderedList', attrs: { start: list.start ?? 1 }, content: items }
    : { type: 'bulletList', content: items };
}

type MdastListItem = Extract<MdastNode, { type: 'listItem' }>;

/**
 * An item of a task list. One that is only a box, `- [ ]` — words to GFM,
 * as nothing follows the box — is the empty task Obsidian draws (A26-01),
 * so an id written after its box is that task's.
 */
function taskItemOf(item: MdastListItem, content: EditorNode[]): EditorNode {
  const box = item.checked === null || item.checked === undefined ? bareBox(content) : null;
  if (box !== null) return { type: 'taskItem', attrs: { checked: box }, content: [EMPTY] };
  return { type: 'taskItem', attrs: { checked: item.checked === true }, content };
}

const EMPTY: EditorNode = { type: 'paragraph' };

/** Whether content that is only `[ ]` or `[x]` is ticked; null for any other. */
function bareBox(content: readonly EditorNode[]): boolean | null {
  const [only, ...others] = content;
  if (others.length > 0 || only?.type !== 'paragraph') return null;
  const [text, ...more] = only.content ?? [];
  if (more.length > 0 || text?.type !== 'text' || (text.marks ?? []).length > 0) return null;
  const ticked = /^\[([ xX])\]$/.exec(text.text ?? '')?.[1];
  return ticked === undefined ? null : ticked !== ' ';
}

/**
 * A list item with the id its own line ends with (P26-01) moved off the text
 * onto the item, which is what the id names: the item and what is under it.
 * A task's id may follow its box with no words between (`- [ ] ^id`).
 */
function anchoredItem(node: EditorNode, item: MdastListItem, body: string): EditorNode {
  const [first] = item.children;
  const [paragraph, ...rest] = node.content ?? [];
  if (first?.type !== 'paragraph' || paragraph?.type !== 'paragraph') return node;
  const afterBox = node.type === 'taskItem' ? idAfterBox(item, body) : null;
  if (afterBox !== null) {
    return {
      ...node,
      attrs: { ...node.attrs, [BLOCK_ANCHOR_ATTR]: afterBox },
      content: [EMPTY, ...rest],
    };
  }
  const anchor = paragraphAnchor(first, body);
  if (anchor === null) return node;
  const text = { ...paragraph, content: withoutTrailingAnchor(paragraph.content ?? [], anchor.id) };
  return {
    ...node,
    attrs: { ...node.attrs, [BLOCK_ANCHOR_ATTR]: anchor.id },
    content: [text, ...rest],
  };
}

/** The id a task's first line holds and nothing else, after its box: `- [ ] ^id`. */
function idAfterBox(item: MdastListItem, body: string): string | null {
  const [first] = item.children;
  if (item.checked === null || item.checked === undefined || first?.type !== 'paragraph')
    return null;
  const start = first.position?.start.offset;
  const end = first.position?.end.offset;
  return start === undefined || end === undefined
    ? null
    : standaloneBlockAnchor(body.slice(start, end));
}

/**
 * A GFM table. Column alignment is carried on the table node rather than the cells,
 * because markdown states it once per column and the editor does not let it be
 * changed yet — keeping it here means it survives an edit to the text.
 */
function tableToEditorNode(table: Extract<MdastNode, { type: 'table' }>): EditorNode | null {
  // A row with more cells than the header — `| a | [[x|y]] |`, whose link's
  // pipe splits a cell — has cells markdown shows nowhere. The editor could
  // only drop them or add a column, so the table is kept as its source (A21-04).
  const columns = table.children[0]?.children.length ?? 0;
  if (table.children.some((row) => row.children.length > columns)) return null;
  const rows: EditorNode[] = [];

  for (const [index, row] of table.children.entries()) {
    const cells: EditorNode[] = [];
    for (const cell of row.children) {
      const inline = inlineContent(withBreaksRead(cell.children));
      if (inline === null) return null;
      cells.push({
        type: index === 0 ? 'tableHeader' : 'tableCell',
        content: [{ type: 'paragraph', ...(inline.length > 0 ? { content: inline } : {}) }],
      });
    }
    rows.push({ type: 'tableRow', content: cells });
  }

  return { type: 'table', attrs: { align: table.align ?? null }, content: rows };
}

/**
 * `<br>` read as the line break it draws, where markdown has no other way to
 * write one: a table cell's line and a heading's (`editor-to-mdast.ts`).
 * Anywhere else it is HTML, and its block is kept as source.
 */
function withBreaksRead(children: readonly PhrasingContent[]): PhrasingContent[] {
  return children.map((child) => {
    if (child.type === 'html' && /^<br\s*\/?>$/i.test(child.value)) return { type: 'break' };
    if (!('children' in child)) return child;
    return { ...child, children: withBreaksRead(child.children) } as PhrasingContent;
  });
}

/** Inline content, or null if any of it is a construct the editor does not model. */
function inlineContent(children: readonly PhrasingContent[]): EditorNode[] | null {
  const nodes: EditorNode[] = [];
  for (const child of children) {
    const converted = inlineToEditorNodes(child, []);
    if (converted === null) return null;
    nodes.push(...converted);
  }
  return nodes;
}

function inlineToEditorNodes(
  node: PhrasingContent,
  marks: readonly EditorMark[],
): EditorNode[] | null {
  switch (node.type) {
    case 'text':
      return [{ type: 'text', text: node.value, ...(marks.length > 0 && { marks }) }];
    case 'wikiLink':
      return wikiLinkOf(node.value, marks);
    case 'inlineCode':
      return [{ type: 'text', text: node.value, marks: [...marks, { type: 'code' }] }];
    case 'break':
      return [{ type: 'hardBreak' }];
    case 'image':
      // A link around the image (`[![alt](src)](href)`) is a mark it carries,
      // so it is written back around it rather than lost.
      return [{ type: 'image', attrs: imageAttrs(node), ...(marks.length > 0 && { marks }) }];
    case 'strong':
      return descend(node.children, [...marks, { type: 'bold' }]);
    case 'emphasis':
      return descend(node.children, [...marks, { type: 'italic' }]);
    case 'delete':
      return descend(node.children, [...marks, { type: 'strike' }]);
    case 'link':
      return descend(node.children, [
        ...marks,
        { type: 'link', attrs: { href: node.url, title: node.title ?? null } },
      ]);
    default:
      return null;
  }
}

/**
 * An image's attributes. A size at the end of its alt text (`![chart|400](…)`,
 * #568) is its own attribute, so the alt text field shows only the words;
 * only a sized image carries one, so an unsized image's node is as before.
 */
function imageAttrs(node: Extract<PhrasingContent, { type: 'image' }>): Record<string, unknown> {
  const { alt, size } = imageAltOf(node);
  return {
    src: node.url,
    alt,
    title: node.title ?? null,
    ...(size !== null && { width: size.width, height: size.height }),
  };
}

/**
 * A wiki link, which the parser reads as one token (`wiki-link-syntax.ts`),
 * so nothing inside it is markup, and `\[\[x]]`, escaped, stays text. Its
 * value is the link as written, read by the same grammar that found it; were
 * the two ever to disagree, the block is kept as its source (null).
 */
function wikiLinkOf(value: string, marks: readonly EditorMark[]): EditorNode[] | null {
  const withMarks = marks.length > 0 ? { marks } : {};
  const link = readWikiLink(value);
  if (link === null) return null;
  return [
    {
      type: 'wikiLink',
      attrs: {
        target: link.target,
        heading: link.heading,
        alias: link.alias,
        // Only an embed carries the flag, so a plain link's node is as before.
        ...(link.embed ? { embed: true } : {}),
      },
      ...withMarks,
    },
  ];
}

function descend(
  children: readonly PhrasingContent[],
  marks: readonly EditorMark[],
): EditorNode[] | null {
  const nodes: EditorNode[] = [];
  for (const child of children) {
    const converted = inlineToEditorNodes(child, marks);
    if (converted === null) return null;
    nodes.push(...converted);
  }
  return nodes;
}
