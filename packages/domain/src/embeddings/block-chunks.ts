import { BLOCK_ANCHOR_ATTR } from '../markdown/block-anchor.ts';
import { namedPlaces, pathKey, type NodePath } from '../markdown/block-outline.ts';
import type { EditorDocument, EditorNode } from '../markdown/editor-node.ts';
import { nodeText } from '../markdown/node-text.ts';
import { passageDigest } from './passage-digest.ts';

/*
 * How a note is cut into the passages that are embedded (P32-02, ADR-0031).
 *
 * A chunk is one block as a link into the note names it: a heading, a
 * paragraph, a list item (its own lines, not the items under it, which are
 * chunks of their own), or a quote, callout, table or piece of code as a
 * whole. A query block, raw markdown the editor does not model, a rule and an
 * embed are passed over: none of them is words the note says.
 *
 * Each chunk is embedded with its note's title and the heading it sits under
 * in front of its words, so "the Q3 budget" in a meeting titled for the
 * budget is found by a question about the budget. That context is part of
 * what is digested: a renamed note or heading re-embeds its blocks, as it
 * should, since their passages now say something else.
 */

/**
 * Bumped whenever the rules below change what a note is cut into: the cache
 * is thrown away and built again, since vectors of the old passages would no
 * longer be what a search compares against.
 */
export const CHUNKER_VERSION = 1;

/**
 * The most characters of a block's own words in one chunk. English runs about
 * four characters a token, so this is about 300 tokens, which leaves the
 * 512-token window room for the title, the heading and words that tokenize
 * worse. A longer block is cut at spaces; one the model still refuses is
 * halved again (`halvedChunk`).
 */
export const MAX_CHUNK_CHARACTERS = 1_200;

/** How long a chunk's excerpt — what a hit shows of it — may be, in characters. */
export const CHUNK_EXCERPT_LENGTH = 240;

const LISTS: ReadonlySet<string> = new Set(['bulletList', 'orderedList', 'taskList']);
const ITEMS: ReadonlySet<string> = new Set(['listItem', 'taskItem']);
/** Blocks embedded whole: everything inside is one passage. */
const WHOLE: ReadonlySet<string> = new Set([
  'paragraph',
  'blockquote',
  'callout',
  'table',
  'codeBlock',
]);
/** Nodes whose children are words in a line, not blocks: joined as they read. */
const INLINE: ReadonlySet<string> = new Set(['paragraph', 'heading']);

/** One passage of a note, as it is embedded and as a hit on it links back. */
export interface BlockChunk {
  /** Its place among the note's chunks, from 0. */
  readonly ordinal: number;
  /** What goes in front of the words: the note's title, and the heading above. */
  readonly context: string;
  /** The block's own words, run together; a long block's share of them. */
  readonly words: string;
  /** The block's `^id` when it has one of its own, for a link to it (ADR-0022). */
  readonly anchor: string | null;
  /** The heading the block sits under — a heading's own words for a heading — or null. */
  readonly heading: string | null;
  /** Of the whole passage: unchanged, and the block is not embedded again. */
  readonly digest: string;
}

/** A block's words before they are cut and numbered. */
interface Piece {
  readonly words: string;
  readonly anchor: string | null;
  readonly heading: string | null;
}

/** The text a chunk is embedded as: its context, then its words. */
export function passageOf(chunk: Pick<BlockChunk, 'context' | 'words'>): string {
  return chunk.context === '' ? chunk.words : `${chunk.context}\n${chunk.words}`;
}

/** What a hit shows of a chunk: its words, cut to `CHUNK_EXCERPT_LENGTH`. */
export function chunkExcerpt(chunk: Pick<BlockChunk, 'words'>): string {
  const { words } = chunk;
  if (words.length <= CHUNK_EXCERPT_LENGTH) return words;
  return `${words.slice(0, characterBoundary(words, CHUNK_EXCERPT_LENGTH - 1)).trimEnd()}…`;
}

/**
 * `text` cut to at most `most` code units, between characters (never inside
 * an emoji or a letter with its accents), without the space the cut leaves.
 */
export function cutAtCharacter(text: string, most: number): string {
  return text.length <= most ? text : text.slice(0, characterBoundary(text, most)).trimEnd();
}

/** Every chunk of a note, in the note's order, numbered from 0. */
export function blockChunks({ title, doc }: { title: string; doc: EditorDocument }): BlockChunk[] {
  const name = squeezed(title);
  const pieces = notePieces(doc, name).flatMap((piece) =>
    cutWords(piece.words, MAX_CHUNK_CHARACTERS).map((words) => ({ ...piece, words })),
  );
  return numbered(pieces.map((piece) => chunkOf(name, piece)));
}

/**
 * A chunk the model refused as too long, as two of the same block, its words
 * split at the last space before their middle; null when its words are a single
 * character, which no split can shorten. Number the note's chunks again
 * (`numbered`) once every refusal is settled.
 */
export function halvedChunk(chunk: BlockChunk): [BlockChunk, BlockChunk] | null {
  if (chunk.words.length < 2) return null;
  const at = splitPoint(chunk.words, Math.ceil(chunk.words.length / 2));
  // One character (an emoji, a letter with its accents) cannot be split in two.
  if (at <= 0 || at >= chunk.words.length) return null;
  const half = (words: string): BlockChunk => withDigest({ ...chunk, words });
  return [half(chunk.words.slice(0, at).trimEnd()), half(chunk.words.slice(at).trimStart())];
}

/** The chunks with their ordinals from 0, in the order given. */
export function numbered(chunks: readonly Omit<BlockChunk, 'ordinal'>[]): BlockChunk[] {
  return chunks.map((chunk, ordinal) => ({ ...chunk, ordinal }));
}

function chunkOf(title: string, piece: Piece): Omit<BlockChunk, 'ordinal'> {
  // A heading is not said twice: not in front of its own words, nor when it repeats the title.
  const above = piece.heading === piece.words || piece.heading === title ? null : piece.heading;
  const context = [title, above ?? ''].filter((part) => part !== '').join('\n');
  return withDigest({ context, ...piece });
}

function withDigest<T extends Omit<BlockChunk, 'ordinal' | 'digest'>>(
  chunk: T,
): T & {
  digest: string;
} {
  return { ...chunk, digest: passageDigest(passageOf(chunk)) };
}

/**
 * The note's blocks as pieces of words, each with its own id and the heading
 * above it. A heading that only repeats the title — the `# Standup` atop
 * `Standup.md` — says nothing the context does not, and is not a piece of
 * its own unless it has an id.
 */
function notePieces(doc: EditorDocument, title: string): Piece[] {
  const named = namedPlaces(doc);
  const ownAnchor = (node: EditorNode, at: NodePath): string | null => {
    const id = node.attrs?.[BLOCK_ANCHOR_ATTR];
    // An id an earlier block also holds names that one (`locateFragment`), not this.
    return typeof id === 'string' && named.get(id) === pathKey(at) ? id : null;
  };
  const comments = commentFilter();
  const pieces: Piece[] = [];
  let heading: string | null = null;
  doc.content.forEach((block, index) => {
    const at = [index];
    if (block.type === 'heading') {
      const words = squeezed(lineText(block, comments));
      if (words === '') return;
      heading = words;
      const anchor = ownAnchor(block, at);
      if (words !== title || anchor !== null) pieces.push({ words, anchor, heading });
    } else if (LISTS.has(block.type)) {
      for (const item of listItems(block, at, comments))
        pieces.push({ words: item.words, anchor: ownAnchor(item.node, item.at), heading });
    } else if (WHOLE.has(block.type)) {
      pieces.push({ words: wordsOf(block, comments), anchor: ownAnchor(block, at), heading });
    }
  });
  return pieces.filter((piece) => piece.words !== '');
}

/** What of a note's text is shown, read in order; the state carries from one call to the next. */
interface CommentFilter {
  /** Text, with what a comment covers left out; a `%%` in it opens or closes one. */
  shown(text: string): string;
  /**
   * Code (a code block or an inline code span): a `%%` in it is not a mark
   * (ADR-0043 §8), but an open comment hides it whole (ADR-0031).
   */
  code(text: string): string;
}

/**
 * Hides what an Obsidian `%%…%%` comment covers, in the order the note is
 * read: a comment may open in one block and close in a later one, and one
 * never closed hides all that follows.
 */
function commentFilter(): CommentFilter {
  let hidden = false;
  return {
    code: (text) => (hidden ? '' : text),
    shown(text) {
      let kept = '';
      let from = 0;
      for (;;) {
        const mark = text.indexOf(COMMENT_MARK, from);
        if (mark < 0) {
          if (!hidden) kept += text.slice(from);
          return kept;
        }
        if (!hidden) kept += text.slice(from, mark);
        hidden = !hidden;
        from = mark + COMMENT_MARK.length;
      }
    },
  };
}

const COMMENT_MARK = '%%';

/** Every item of a list, nested ones after the item they are under, with its own words. */
function listItems(
  list: EditorNode,
  at: NodePath,
  comments: CommentFilter,
): { node: EditorNode; at: NodePath; words: string }[] {
  const found: { node: EditorNode; at: NodePath; words: string }[] = [];
  (list.content ?? []).forEach((item, index) => {
    if (!ITEMS.has(item.type)) return;
    const itemAt = [...at, index];
    const own = (item.content ?? []).filter((child) => !LISTS.has(child.type));
    const words = squeezed(own.map((child) => wordsOf(child, comments)).join(' '));
    found.push({ node: item, at: itemAt, words });
    (item.content ?? []).forEach((child, childIndex) => {
      if (LISTS.has(child.type)) found.push(...listItems(child, [...itemAt, childIndex], comments));
    });
  });
  return found;
}

/**
 * A node's shown words as they read, with a space between blocks and table
 * cells. A callout says its title first.
 */
function wordsOf(node: EditorNode, comments: CommentFilter): string {
  if (node.type === 'codeBlock') return comments.code(squeezed(nodeText(node)));
  if (INLINE.has(node.type) || node.content === undefined)
    return squeezed(lineText(node, comments));
  const rawTitle = node.type === 'callout' ? node.attrs?.['title'] : undefined;
  const title = typeof rawTitle === 'string' ? [comments.shown(rawTitle)] : [];
  const body = node.content.map((child) => wordsOf(child, comments));
  return squeezed([...title, ...body].join(' '));
}

/**
 * A line's shown text as `nodeText` reads it, but an embed (`![[Other]]`) is
 * another note's words, not this one's.
 */
function lineText(node: EditorNode, comments: CommentFilter): string {
  if (node.type === 'wikiLink' && node.attrs?.['embed'] === true) return '';
  if (node.type === 'text' && isInlineCode(node)) return comments.code(nodeText(node));
  if (node.content === undefined || node.type === 'text') return comments.shown(nodeText(node));
  return node.content.map((child) => lineText(child, comments)).join('');
}

function isInlineCode(node: EditorNode): boolean {
  return (node.marks ?? []).some((mark) => mark.type === 'code');
}

/** Words cut at spaces into runs of at most `most` characters; a longer word is cut where it must be. */
function cutWords(words: string, most: number): string[] {
  const runs: string[] = [];
  let rest = words;
  while (rest.length > most) {
    const at = splitPoint(rest, most);
    runs.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest !== '') runs.push(rest);
  return runs;
}

/** Where to cut `words` at most `wanted` code units in: after the last space before it, else between characters. */
function splitPoint(words: string, wanted: number): number {
  const before = words.lastIndexOf(' ', wanted);
  return before > 0 ? before + 1 : characterBoundary(words, wanted);
}

const characters = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** How far either side of a cut is looked at to find where a character begins: longer than any emoji sequence. */
const CHARACTER_REACH = 64;

/**
 * The last place at or before `index` where a user-perceived character begins
 * (`Intl.Segmenter`): a cut there never splits a surrogate pair, an emoji with
 * its modifiers, or a letter from its accents. 0 when the text up to `index` is
 * one character, which no cut can shorten. A "character" longer than the reach
 * (a stack of combining marks) is cut `CHARACTER_REACH` before `index`, so a
 * caller always makes progress.
 */
function characterBoundary(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  const from = Math.max(0, index - CHARACTER_REACH);
  let boundary = from;
  for (const { index: offset } of characters.segment(text.slice(from, index + CHARACTER_REACH))) {
    if (from + offset > index) break;
    boundary = from + offset;
  }
  return boundary;
}

const squeezed = (text: string): string => text.replace(/\s+/g, ' ').trim();
