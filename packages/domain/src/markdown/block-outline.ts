import { BLOCK_ANCHOR_ATTR, type AnchorStyle } from './block-anchor.ts';
import type { EditorDocument, EditorNode } from './editor-node.ts';
import type { LinkFragment } from './link-fragment.ts';
import { nodeText } from './node-text.ts';
import { linkBreakingCharacter } from './wikilink.ts';
import { QUERY_BLOCK_NODE } from '../query-block/query-block.ts';

/*
 * A note's blocks as a link into them sees them (P26-01, P26-02): which of
 * them can carry an id, which one a `#^id` or a `#Heading` names, and what a
 * picker offers of them. Read off the editor's document, so the editor, the
 * index and a write to another note agree about what a block is.
 */

/** The note's own blocks that carry their id on a line after them. */
const LINE_ANCHORED: ReadonlySet<string> = new Set([
  'blockquote',
  'callout',
  'codeBlock',
  QUERY_BLOCK_NODE,
  'table',
  'bulletList',
  'orderedList',
  'taskList',
  'rawBlock',
]);

/** The note's own blocks that carry their id after their words, as Obsidian writes them. */
const INLINE_ANCHORED: ReadonlySet<string> = new Set(['paragraph', 'heading']);

const ITEMS: ReadonlySet<string> = new Set(['listItem', 'taskItem']);
const LISTS: ReadonlySet<string> = new Set(['bulletList', 'orderedList', 'taskList']);

/** Blocks whose insides hold no list item an id could name. */
const OPAQUE: ReadonlySet<string> = new Set([
  'table',
  'codeBlock',
  QUERY_BLOCK_NODE,
  'rawBlock',
  'paragraph',
  'heading',
]);

/** How long a block's preview may be, in characters: two lines of a picker, about. */
export const BLOCK_PREVIEW_LENGTH = 140;

/** Where in a block a node is: the index of each child on the way down. */
export type NodePath = readonly number[];

/** How one of the note's own blocks carries an id, or null when it cannot carry one. */
export function anchorStyleOf(node: EditorNode): AnchorStyle | null {
  if (INLINE_ANCHORED.has(node.type)) return hasText(node) ? 'inline' : null;
  return LINE_ANCHORED.has(node.type) ? 'line' : null;
}

/**
 * Whether a node is one of `anchorPlaces`, told by the kinds of the blocks
 * around it — `ancestors`, outermost first, starting with the note's own
 * block; none for that block itself. The editor asks this of its nodes, so
 * it keeps each id where the file can write it.
 */
export function isAnchorPlace(node: EditorNode, ancestors: readonly string[]): boolean {
  if (ancestors.length === 0) return anchorStyleOf(node) !== null;
  if (ancestors.some((type) => OPAQUE.has(type))) return false;
  // A task's id follows its checkbox, words or none (`- [ ] ^id`, as Obsidian
  // writes it); another item's follows its first line, when that has words.
  if (node.type === 'taskItem') return true;
  const first = node.content?.[0];
  return node.type === 'listItem' && first?.type === 'paragraph' && hasText(first);
}

/**
 * Every place in one of the note's own blocks where an id can be, in the
 * order the ids are written in the file: each task, and each other list item
 * whose first line is text, outermost first, then the block's own, when it
 * takes one. A path is relative to the block: `[]` is the block itself.
 */
export function anchorPlaces(block: EditorNode): NodePath[] {
  const places: NodePath[] = [];
  const visit = (node: EditorNode, path: NodePath, ancestors: readonly string[]) => {
    if (path.length > 0 && isAnchorPlace(node, ancestors)) places.push(path);
    if (OPAQUE.has(node.type)) return;
    const inside = [...ancestors, node.type];
    (node.content ?? []).forEach((child, index) => visit(child, [...path, index], inside));
  };
  visit(block, [], []);
  if (isAnchorPlace(block, [])) places.push([]);
  return places;
}

/** The ids at each of `anchorPlaces`, in order: null where a place has none. */
export function blockAnchorsOf(block: EditorNode): (string | null)[] {
  return anchorPlaces(block).map((path) => anchorOf(nodeAt(block, path)));
}

/** A node's attributes without its block id. */
export function withoutAnchorAttr(
  attrs: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== BLOCK_ANCHOR_ATTR));
}

/** The block with no id anywhere in it. */
export function withoutBlockAnchors(node: EditorNode): EditorNode {
  const content = node.content?.map(withoutBlockAnchors);
  const attrs = node.attrs;
  if (attrs === undefined || !(BLOCK_ANCHOR_ATTR in attrs)) {
    return content === undefined ? node : { ...node, content };
  }
  const rest = withoutAnchorAttr(attrs);
  return {
    ...node,
    attrs: rest,
    ...(content !== undefined && { content }),
  };
}

/**
 * The block with each id where the file writes it (`anchorPlaces`). An id
 * the editor holds on a node inside one of those places — a paragraph made
 * a list item keeps its id on its paragraph, a quoted one on the quote's —
 * is the place's, where the place has none of its own. One that finds its
 * place taken is kept as words at the end of the words it named, ` ^id`,
 * read back as text: never let go without a trace. Only an id on a block
 * with no words anywhere near it, which names nothing to show, goes with it.
 */
export function withAnchorsAtPlaces(block: EditorNode): EditorNode {
  let holdsAny = false;
  eachNode(block, (node) => {
    holdsAny ||= anchorOf(node) !== null;
  });
  if (!holdsAny) return block;
  const places = new Map(anchorPlaces(block).map((path) => [pathKey(path), path]));
  const held = new Map<string, string>();
  for (const [key, path] of places) {
    const id = anchorOf(nodeAt(block, path));
    if (id !== null) held.set(key, id);
  }
  const unplaced: { path: NodePath; id: string }[] = [];
  eachNode(block, (node, path) => {
    const id = anchorOf(node);
    if (id === null || places.has(pathKey(path))) return;
    const around = placeAround(path, places);
    if (around !== null && !held.has(around)) held.set(around, id);
    else if (around === null || held.get(around) !== id) unplaced.push({ path, id });
  });
  let kept = withoutBlockAnchors(block);
  for (const [key, id] of held) kept = withAnchorIn(kept, places.get(key) ?? [], id);
  for (const { path, id } of unplaced) kept = withIdAsWords(kept, path, id);
  return kept;
}

export const pathKey = (path: NodePath): string => path.join('.');

/** The nearest of `places` that holds the node at `path`, as its key, or null. */
function placeAround(path: NodePath, places: ReadonlyMap<string, NodePath>): string | null {
  for (let length = path.length - 1; length >= 0; length -= 1) {
    const key = pathKey(path.slice(0, length));
    if (places.has(key)) return key;
  }
  return null;
}

/** Calls `visit` with every node of `node`, itself first, and its path from it. */
function eachNode(node: EditorNode, visit: (node: EditorNode, path: NodePath) => void): void {
  const walk = (current: EditorNode, path: NodePath) => {
    visit(current, path);
    (current.content ?? []).forEach((child, index) => walk(child, [...path, index]));
  };
  walk(node, []);
}

/**
 * `block` with ` ^id` after the words of the node at `path` — its last
 * paragraph or heading with words — or, where it has none, after the
 * block's own last words. A block with no words at all is as it was.
 */
function withIdAsWords(block: EditorNode, path: NodePath, id: string): EditorNode {
  const inside = lastWordsIn(nodeAt(block, path));
  const at = inside === null ? lastWordsIn(block) : [...path, ...inside];
  if (at === null) return block;
  return withNodeAt(block, at, (node) => ({
    ...node,
    content: [...(node.content ?? []), { type: 'text', text: ` ^${id}` }],
  }));
}

/** The path to the last paragraph or heading with words in `node`, itself included, or null. */
function lastWordsIn(node: EditorNode): NodePath | null {
  let found: NodePath | null = null;
  eachNode(node, (current, path) => {
    if (INLINE_ANCHORED.has(current.type) && hasText(current)) found = path;
  });
  return found;
}

/** `node` with the node at `path` in it made what `change` makes of it. */
function withNodeAt(
  node: EditorNode,
  path: NodePath,
  change: (node: EditorNode) => EditorNode,
): EditorNode {
  const [first, ...rest] = path;
  if (first === undefined) return change(node);
  const content = (node.content ?? []).map((child, index) =>
    index === first ? withNodeAt(child, rest, change) : child,
  );
  return { ...node, content };
}

/** Every id the document holds, wherever it is. */
export function anchorsIn(doc: EditorDocument): Set<string> {
  const found = new Set<string>();
  const visit = (node: EditorNode) => {
    const id = anchorOf(node);
    if (id !== null) found.add(id);
    node.content?.forEach(visit);
  };
  doc.content.forEach(visit);
  return found;
}

/** The document with the node at `at` — a path from the document — given `id`, or none. */
export function withAnchorAt(doc: EditorDocument, at: NodePath, id: string | null): EditorDocument {
  const [first, ...rest] = at;
  if (first === undefined) return doc;
  const content = doc.content.map((block, index) =>
    index === first ? withAnchorIn(block, rest, id) : block,
  );
  return { ...doc, content };
}

function withAnchorIn(node: EditorNode, path: NodePath, id: string | null): EditorNode {
  return withNodeAt(node, path, (held) => {
    const attrs = withoutAnchorAttr(held.attrs ?? {});
    return { ...held, attrs: id === null ? attrs : { ...attrs, [BLOCK_ANCHOR_ATTR]: id } };
  });
}

/** One entry of a note's outline, as the `#` picker offers it. */
export type OutlineEntry =
  | {
      readonly kind: 'heading';
      readonly text: string;
      readonly level: number;
      readonly at: NodePath;
    }
  | {
      readonly kind: 'block';
      /** The block's words, run together and cut to `BLOCK_PREVIEW_LENGTH`. */
      readonly text: string;
      /** Its id, when something already refers to it; null until then. */
      readonly id: string | null;
      /** What kind of block it is: `paragraph`, `listItem`, `table`… */
      readonly type: string;
      readonly at: NodePath;
    };

/**
 * The note's headings and blocks in order, as a link into it can name them:
 * each heading; each paragraph with words in it; each list item, nested ones
 * too; each quote, callout, table and piece of code as a whole. A rule, a
 * card, an embed and markdown the editor does not model are passed over.
 */
export function blockOutline(doc: EditorDocument): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const named = namedPlaces(doc);
  doc.content.forEach((block, index) => {
    if (block.type === 'heading') {
      const text = squeezed(nodeText(block));
      const level = block.attrs?.['level'];
      if (text !== '')
        entries.push({
          kind: 'heading',
          text,
          level: typeof level === 'number' ? level : 1,
          at: [index],
        });
      return;
    }
    if (block.type === 'rawBlock') return;
    for (const path of anchorPlaces(block)) {
      // A list is offered item by item; the list as a whole is not one block to show.
      if (path.length === 0 && LISTS.has(block.type)) continue;
      const node = nodeAt(block, path);
      const shown = ITEMS.has(node.type) ? node.content?.[0] : node;
      const text = preview(shown === undefined ? '' : nodeText(shown));
      if (text === '') continue;
      const id = anchorOf(node);
      const at = [index, ...path];
      entries.push({
        kind: 'block',
        text,
        // An id an earlier block also holds names that one (`locateFragment`), not this.
        id: id !== null && named.get(id) === pathKey(at) ? id : null,
        type: node.type,
        at,
      });
    }
  });
  return entries;
}

/** Each id in the note, and the place it names — the first that holds it — as a path's key. */
export function namedPlaces(doc: EditorDocument): Map<string, string> {
  const named = new Map<string, string>();
  doc.content.forEach((block, index) => {
    for (const path of anchorPlaces(block)) {
      const id = anchorOf(nodeAt(block, path));
      if (id !== null && !named.has(id)) named.set(id, pathKey([index, ...path]));
    }
  });
  return named;
}

/**
 * Entries as the picker offers them (A26-01): an id two of them share is
 * offered on neither, so picking one asks its note for the id that names it
 * (`anchorBlock`) rather than linking an id that may name the other.
 */
export function offeredByOwnId(entries: readonly OutlineEntry[]): OutlineEntry[] {
  const holders = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind === 'block' && entry.id !== null)
      holders.set(entry.id, (holders.get(entry.id) ?? 0) + 1);
  }
  return entries.map((entry) =>
    entry.kind === 'block' && entry.id !== null && (holders.get(entry.id) ?? 0) > 1
      ? { ...entry, id: null }
      : entry,
  );
}

/** How many headings and blocks the `#` picker lists at once. */
export const OUTLINE_CHOICES = 30;

/**
 * What the `#` after a page's name offers for what has been typed after it
 * (P26-02): the headings and blocks whose words hold it, regardless of case,
 * in the note's order. A heading whose words hold link syntax — `[`, `]`,
 * `|`, `#`, `^` — is left out: no link could name it (`linkBreakingCharacter`).
 */
export function matchingOutline(
  entries: readonly OutlineEntry[],
  query: string,
  limit: number = OUTLINE_CHOICES,
): OutlineEntry[] {
  const wanted = query.trim().toLowerCase();
  return entries
    .filter((entry) => entry.kind === 'block' || linkBreakingCharacter(entry.text) === null)
    .filter((entry) => entry.text.toLowerCase().includes(wanted))
    .slice(0, limit);
}

/** A block that has an id: the id, and a line of what the block says. */
export interface AnchoredBlock {
  readonly id: string;
  readonly text: string;
}

/**
 * Every block in the note that has an id, in order, each id once: what the
 * index keeps so a `#^id` can be found without reading every note.
 */
export function anchoredBlocks(doc: EditorDocument): AnchoredBlock[] {
  const found = new Map<string, string>();
  for (const block of doc.content) {
    for (const path of anchorPlaces(block)) {
      const node = nodeAt(block, path);
      const id = anchorOf(node);
      const shown = ITEMS.has(node.type) ? node.content?.[0] : node;
      if (id !== null && !found.has(id))
        found.set(id, preview(shown === undefined ? '' : nodeText(shown)));
    }
  }
  return [...found].map(([id, text]) => ({ id, text }));
}

/**
 * Where the block or heading a link names is: the path from the document to
 * it, or null when the note has none. A heading is matched by its words as
 * written, then regardless of case, and the first of a name wins.
 */
export function locateFragment(doc: EditorDocument, fragment: LinkFragment): NodePath | null {
  if (fragment.kind === 'block') {
    for (const [index, block] of doc.content.entries()) {
      const path = anchorPlaces(block).find(
        (place) => anchorOf(nodeAt(block, place)) === fragment.id,
      );
      if (path !== undefined) return [index, ...path];
    }
    return null;
  }
  const headings = [...doc.content.entries()].filter(([, block]) => block.type === 'heading');
  const wanted = fragment.heading.trim();
  const exact = headings.find(([, block]) => squeezed(nodeText(block)) === wanted);
  const folded = headings.find(
    ([, block]) => squeezed(nodeText(block)).toLowerCase() === wanted.toLowerCase(),
  );
  const found = exact ?? folded;
  return found === undefined ? null : [found[0]];
}

/**
 * What an embed of `fragment` shows of the note, as blocks of their own: the
 * block, a list item in a list of its own, or a heading and everything under
 * it until the next heading as high. Null when the note has no such block.
 */
export function fragmentContent(doc: EditorDocument, fragment: LinkFragment): EditorNode[] | null {
  const at = locateFragment(doc, fragment);
  if (at === null) return null;
  const [index] = at as [number, ...number[]];
  const block = doc.content[index] as EditorNode;
  if (fragment.kind === 'heading') return section(doc, index);
  if (at.length === 1) return [block];
  const item = nodeAt(block, at.slice(1));
  const list = nodeAt(block, at.slice(1, -1));
  const position = at.at(-1) as number;
  const start = list.attrs?.['start'];
  return [
    {
      ...list,
      ...(typeof start === 'number' && { attrs: { ...list.attrs, start: start + position } }),
      content: [item],
    },
  ];
}

/** A heading and the blocks under it, up to the next heading at its level or above. */
function section(doc: EditorDocument, index: number): EditorNode[] {
  const heading = doc.content[index] as EditorNode;
  const level = levelOf(heading);
  const after = doc.content.slice(index + 1);
  const end = after.findIndex((block) => block.type === 'heading' && levelOf(block) <= level);
  return [heading, ...(end === -1 ? after : after.slice(0, end))];
}

/** The node at `path` from `node`. */
export function nodeAt(node: EditorNode, path: NodePath): EditorNode {
  return path.reduce<EditorNode>((current, index) => current.content?.[index] ?? current, node);
}

function anchorOf(node: EditorNode): string | null {
  const id = node.attrs?.[BLOCK_ANCHOR_ATTR];
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Whether a paragraph or a heading has words for an id to follow: anything
 * but spaces, of any kind. After nothing but spaces an id is alone on its
 * line, and is read as a block of its own.
 */
function hasText(node: EditorNode | undefined): boolean {
  if (node === undefined || !INLINE_ANCHORED.has(node.type)) return false;
  return (node.content ?? []).some(
    (child) => child.type !== 'text' || (child.text ?? '').trim() !== '',
  );
}

function levelOf(heading: EditorNode): number {
  const level = heading.attrs?.['level'];
  return typeof level === 'number' ? level : 1;
}

const squeezed = (text: string): string => text.replace(/\s+/g, ' ').trim();

function preview(text: string): string {
  const words = squeezed(text);
  return words.length <= BLOCK_PREVIEW_LENGTH
    ? words
    : `${words.slice(0, BLOCK_PREVIEW_LENGTH - 1).trimEnd()}…`;
}
