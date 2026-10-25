import { Extension } from '@tiptap/core';
import {
  NodeSelection,
  Plugin,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { dropPoint, liftTarget, Mapping } from '@tiptap/pm/transform';
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { BLOCK_ANCHOR_ATTR, highlightAsPlainQuote, isTombstoneBlock } from '@dfai/domain';
import { READ_FROM_FILE } from './block-anchor.ts';
import { pastedRawBlocks } from './raw-block.ts';

/*
 * A removed Kindle highlight's tombstone is hidden (ADR-0043 §5) but is still
 * an atom of the document, and the next sync reads it to know the passage was
 * removed: lose it and the removed highlight comes back (#534). The person
 * cannot see it, so nothing they do next to it may take it. A step that drops
 * it — Backspace or Delete beside it, a selection across it deleted, cut or
 * pasted over — is let happen for everything the person can see, and the
 * tombstone is put back, after the block the deletion joined, in the same
 * undo step. Only a note read from its file (the highlight was removed on the
 * person's word) takes one away.
 *
 * A tombstone is a top-level HTML block of the file (ADR-0043): one a step
 * moved into a container — the blocks around it wrapped in a quote or a list
 * — would be written as a line of that quote, the person's words and no
 * tombstone. So it is taken back out to the top level where the wrap left it,
 * splitting the container there, and counted wherever it is, so a wrap is
 * never read as a deletion and put back a second time. A numbered list split
 * so numbers its second half on from the first, as it read before the wrap.
 *
 * Nor is one ever put on the clipboard, or taken off it: copied with the
 * words around it, a paste would hold it twice, or carry a removed
 * highlight's tombstone into a note that never had it.
 *
 * Nor is a highlight ever pasted as one: a copy holding its marker would be
 * a second live highlight of the passage, in its own note or another. Pasted,
 * it is a plain quote, its words and comment kept, its marker and id dropped.
 * A highlight dragged within its note and moved stays one; dragged and
 * copied, the copy is a plain quote, as a paste is.
 */

/** Whether `node` is a removed highlight's tombstone, which nobody sees (ADR-0043 §5). */
export const isTombstone = (node: ProseMirrorNode): boolean =>
  node.type.name === 'rawBlock' && isTombstoneBlock(String(node.attrs['markdown'] ?? ''));

interface Held {
  readonly node: ProseMirrorNode;
  readonly pos: number;
  /** Inside a container rather than a block of the note itself. */
  readonly nested: boolean;
}

/** Every tombstone in the note, at any depth, in document order. */
function tombstonesIn(doc: ProseMirrorNode): Held[] {
  const held: Held[] = [];
  doc.descendants((node, pos, parent) => {
    if (isTombstone(node)) held.push({ node, pos, nested: parent !== doc });
    // A textblock holds no blocks: nothing below it is looked at.
    return !node.isTextblock;
  });
  return held;
}

const keyOf = (node: ProseMirrorNode): string => String(node.attrs['markdown']);

/** How many of each tombstone `held` holds, by its bytes. */
function countsOf(held: readonly Held[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { node } of held) counts.set(keyOf(node), (counts.get(keyOf(node)) ?? 0) + 1);
  return counts;
}

/**
 * Lifts the tombstones the step moved into a container back to the top
 * level, last first so none shifts another. One already nested before the
 * step — read so from the file — is left where it is.
 */
function liftMovedIn(tr: Transaction, before: readonly Held[]): void {
  const nestedBefore = countsOf(before.filter(({ nested }) => nested));
  const moved = tombstonesIn(tr.doc).filter(({ node, nested }) => {
    if (!nested) return false;
    const left = nestedBefore.get(keyOf(node)) ?? 0;
    nestedBefore.set(keyOf(node), left - 1);
    return left <= 0;
  });
  for (const { pos } of moved.reverse()) liftToTopLevel(tr, pos);
}

/** Lifts the block at `pos` out of every container it is in, splitting each around it. */
function liftToTopLevel(tr: Transaction, start: number): void {
  let pos = start;
  while (tr.doc.resolve(pos).depth > 0) {
    const node = tr.doc.nodeAt(pos);
    if (node === null) return;
    const range = tr.doc.resolve(pos).blockRange(tr.doc.resolve(pos + node.nodeSize));
    const target = range === null ? null : liftTarget(range);
    // A container it cannot leave (an isolating one): it stays, counted, rather than be duplicated.
    if (range === null || target === null) return;
    const from = tr.steps.length;
    tr.lift(range, target);
    pos = tr.mapping.slice(from).map(pos, 1);
    numberOn(tr, pos);
  }
}

/**
 * The block at `pos` was just lifted out of a numbered list, splitting it:
 * the half after it numbers on from the half before. Both halves are copies
 * of the one list, so they start alike; lists that do not were the person's.
 */
function numberOn(tr: Transaction, pos: number): void {
  const $pos = tr.doc.resolve(pos);
  const lifted = tr.doc.nodeAt(pos);
  const before = $pos.parent.maybeChild($pos.index() - 1);
  const after = $pos.parent.maybeChild($pos.index() + 1);
  if (lifted === null || before === null || after === null) return;
  if (before.type.name !== 'orderedList' || after.type !== before.type) return;
  const start = before.attrs['start'];
  if (typeof start !== 'number' || after.attrs['start'] !== start) return;
  tr.setNodeMarkup(pos + lifted.nodeSize, undefined, {
    ...after.attrs,
    start: start + before.childCount,
  });
}

/** `content` without its tombstones, and without a container they were all it held. */
function withoutTombstones(content: Fragment): Fragment {
  const kept: ProseMirrorNode[] = [];
  content.forEach((node) => {
    if (isTombstone(node)) return;
    if (node.isTextblock || node.isLeaf || node.childCount === 0) {
      kept.push(node);
      return;
    }
    const inner = withoutTombstones(node.content);
    if (inner.childCount > 0) kept.push(node.copy(inner));
  });
  return Fragment.from(kept);
}

/**
 * A clipboard slice with no tombstone in it, copied or pasted. A container
 * dropped at an edge leaves the slice open no deeper than what is left.
 */
function offTheClipboard(slice: Slice): Slice {
  const content = withoutTombstones(slice.content);
  if (content.eq(slice.content)) return slice;
  const deepest = Slice.maxOpen(content);
  return new Slice(
    content,
    Math.min(slice.openStart, deepest.openStart),
    Math.min(slice.openEnd, deepest.openEnd),
  );
}

/** `content` with each highlight block made a plain quote, and one with nothing to show dropped. */
function highlightsAsQuotes(content: Fragment): Fragment {
  const kept: ProseMirrorNode[] = [];
  content.forEach((node) => {
    if (node.type.name === 'rawBlock') {
      const quote = highlightAsPlainQuote(String(node.attrs['markdown'] ?? ''));
      if (quote === null) kept.push(node);
      else if (quote !== '') {
        kept.push(node.type.create({ ...node.attrs, markdown: quote, [BLOCK_ANCHOR_ATTR]: null }));
      }
      return;
    }
    if (node.isTextblock || node.isLeaf || node.childCount === 0) kept.push(node);
    else kept.push(node.copy(highlightsAsQuotes(node.content)));
  });
  return Fragment.from(kept);
}

/** `slice` with each highlight made a plain quote; the same slice when it holds none. */
function quotedSlice(slice: Slice): Slice {
  const content = highlightsAsQuotes(slice.content);
  if (content.eq(slice.content)) return slice;
  const deepest = Slice.maxOpen(content);
  return new Slice(
    content,
    Math.min(slice.openStart, deepest.openStart),
    Math.min(slice.openEnd, deepest.openEnd),
  );
}

/**
 * A pasted slice: no tombstone, and no highlight. Run before RawBlock's own
 * paste transform (this extension's priority), so a highlight is made a quote
 * — its id dropped with it — before its marker line is taken off as any
 * marker's is. A drag within the note keeps
 * its highlights here: whether it moves or copies is decided only at the drop,
 * from the copy key held then, so {@link dropAsCopy} decides it.
 */
function pastedOff(slice: Slice, view: EditorView): Slice {
  const clean = offTheClipboard(slice);
  return view.dragging === null ? quotedSlice(clean) : clean;
}

/**
 * A drag within the note dropped as a copy is cleaned as a paste is, in the
 * paste's order: its highlights made plain quotes, so the passage keeps one
 * live highlight, then its raw blocks' markers and ids taken off (raw-block.ts).
 * A move — or a copy with nothing to clean — is left to ProseMirror's own drop.
 */
function dropAsCopy(view: EditorView, event: DragEvent, slice: Slice, moved: boolean): boolean {
  if (moved) return false;
  const quoted = copiedAsPasted(slice);
  if (quoted === slice) return false;
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (at === null) return false;
  const insertAt = dropPoint(view.state.doc, at.pos, quoted) ?? at.pos;
  const tr = view.state.tr;
  const single = quoted.openStart === 0 && quoted.openEnd === 0 && quoted.content.childCount === 1;
  const only = single ? quoted.content.firstChild : null;
  if (only !== null) tr.replaceRangeWith(insertAt, insertAt, only);
  else tr.replaceRange(insertAt, insertAt, quoted);
  event.preventDefault();
  if (tr.doc.eq(view.state.doc)) return true;
  selectDropped(view, tr, { insertAt, only });
  view.focus();
  view.dispatch(tr.setMeta('uiEvent', 'drop'));
  return true;
}

/**
 * A copy of `slice` made within the note — a drag dropped as a copy, a block
 * duplicated (#569) — cleaned as a paste is, in the paste's order: no
 * tombstone, each highlight a plain quote, then its raw blocks' markers and
 * ids taken off (raw-block.ts). The same slice when there is nothing to clean.
 */
export function copiedAsPasted(slice: Slice): Slice {
  return pastedRawBlocks(quotedSlice(offTheClipboard(slice)));
}

/**
 * Selects what the drop put in, not the block it was copied from: the one
 * node, or the stretch inserted. Mirrors prosemirror-view 1.42's handleDrop.
 */
function selectDropped(
  view: EditorView,
  tr: Transaction,
  { insertAt, only }: { insertAt: number; only: ProseMirrorNode | null },
): void {
  const $pos = tr.doc.resolve(insertAt);
  if (only !== null && NodeSelection.isSelectable(only) && $pos.nodeAfter?.sameMarkup(only)) {
    tr.setSelection(new NodeSelection($pos));
    return;
  }
  let end = tr.mapping.map(insertAt);
  tr.mapping.maps[tr.mapping.maps.length - 1]?.forEach((_from, _to, _newFrom, newTo) => {
    end = newTo;
  });
  const $end = tr.doc.resolve(end);
  const between = view.someProp('createSelectionBetween', (create) => create(view, $pos, $end));
  tr.setSelection(between ?? TextSelection.between($pos, $end));
}

/** The tombstones the transactions took, put back at the block boundary nearest where they were. */
function restoration(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  if (!transactions.some((transaction) => transaction.docChanged)) return null;
  if (transactions.some((transaction) => transaction.getMeta(READ_FROM_FILE) === true)) return null;
  const before = tombstonesIn(oldState.doc);
  if (before.length === 0) return null;
  const tr = newState.tr;
  liftMovedIn(tr, before);
  const remaining = countsOf(tombstonesIn(tr.doc));
  const lost = before.filter(({ node }) => {
    const left = remaining.get(keyOf(node)) ?? 0;
    remaining.set(keyOf(node), Math.max(0, left - 1));
    return left === 0;
  });
  if (lost.length === 0) return tr.docChanged ? tr : null;
  const mapping = new Mapping();
  for (const transaction of transactions) mapping.appendMapping(transaction.mapping);
  mapping.appendMapping(tr.mapping);
  // Boundaries are found in the document as it is, then inserted last to first so none shifts another.
  const putBack = lost
    .map(({ node, pos }) => ({ node, at: blockBoundary(tr.doc, mapping.map(pos, -1)) }))
    .sort((one, other) => other.at - one.at);
  for (const { node, at } of putBack) tr.insert(at, node);
  return tr;
}

/** `pos` if it is between top-level blocks, else the end of the top-level block it is in. */
function blockBoundary(doc: ProseMirrorNode, pos: number): number {
  const $pos = doc.resolve(Math.min(pos, doc.content.size));
  return $pos.depth === 0 ? $pos.pos : $pos.after(1);
}

/**
 * Backspace at the start of a block, or Delete at its end, with only hidden
 * tombstones between it and the next block: joins the two blocks across them
 * (the tombstone is put back after) rather than selecting what is not drawn.
 * Answers false where this is not the case, so the key does what it always does.
 */
function joinAcross(view: EditorView, direction: -1 | 1): boolean {
  const { selection, doc } = view.state;
  if (!selection.empty) return false;
  const $head = selection.$head;
  if ($head.depth !== 1 || !$head.parent.isTextblock) return false;
  const atEdge =
    direction < 0 ? $head.parentOffset === 0 : $head.parentOffset === $head.parent.content.size;
  if (!atEdge) return false;
  let index = $head.index(0) + direction;
  if (doc.maybeChild(index) === null || !isTombstone(doc.child(index))) return false;
  while (doc.maybeChild(index) !== null && isTombstone(doc.child(index))) index += direction;
  const other = doc.maybeChild(index);
  // Nothing to join to: the key does nothing rather than reach for what it cannot see.
  if (other === null || !other.isTextblock) return true;
  let otherStart = 0;
  for (let at = 0; at < index; at += 1) otherStart += doc.child(at).nodeSize;
  const joined =
    direction < 0
      ? { from: otherStart + other.nodeSize - 1, to: $head.pos }
      : { from: $head.pos, to: otherStart + 1 };
  const tr = view.state.tr.delete(joined.from, joined.to);
  view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(joined.from))));
  return true;
}

/**
 * Above the other keymaps (priority), so a key beside a tombstone is answered
 * here before Backspace selects the atom it cannot show.
 */
export const TombstoneGuard = Extension.create({
  name: 'tombstoneGuard',
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: restoration,
        props: {
          transformCopied: offTheClipboard,
          transformPasted: pastedOff,
          handleDrop: dropAsCopy,
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => joinAcross(editor.view, -1),
      Delete: ({ editor }) => joinAcross(editor.view, 1),
    };
  },
});
