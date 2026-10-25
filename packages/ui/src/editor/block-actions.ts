import { closeHistory } from '@tiptap/pm/history';
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  NodeSelection,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { BLOCK_ANCHOR_ATTR } from '@dfai/domain';
import { withoutIdsHeldBy } from './block-anchor.ts';
import { copiedAsPasted, isTombstone } from './tombstone-guard.ts';

/*
 * What a block's handle does to the note (#569): add a block above or below
 * it, duplicate it, move it up or down, delete it. Each is one transaction —
 * one step to undo, never run together with the typing before it — and the
 * rules the rest of the editor keeps hold here too:
 *
 * - A duplicate is a copy made within the note, so it is cleaned as a paste
 *   is (PR #534): a highlight becomes a plain quote with no id, no `^id` the
 *   note holds is given to it (ADR-0022), and no tombstone is carried.
 * - A move is the same block, its id and its highlight marker with it.
 * - A hidden tombstone is never what a handle acts on, and is stepped over
 *   by a move rather than swapped with, so the person never moves a block
 *   "nowhere"; the guard keeps every tombstone where it was.
 * - A highlight is deleted by the literature note's own write, which leaves
 *   a Kindle highlight's tombstone (ADR-0043 §5), never by an edit here.
 */

/** A block a handle acts on: where it starts, and the block. */
export interface BlockTarget {
  readonly pos: number;
  readonly node: ProseMirrorNode;
}

/** The actions on a block's menu, in its order. */
export const BLOCK_ACTIONS = [
  'addAbove',
  'addBelow',
  'duplicate',
  'moveUp',
  'moveDown',
  'delete',
] as const;

export type BlockAction = (typeof BLOCK_ACTIONS)[number];

/** The blocks of a list that each have a handle of their own, as Notion's items do. */
const ITEM_TYPES = new Set(['listItem', 'taskItem']);

/** Whether `node` is an item of a list: a bullet, a numbered item, a task. */
export const isListItem = (node: ProseMirrorNode): boolean => ITEM_TYPES.has(node.type.name);

/**
 * On a transaction that is one of these actions, so the handle's plugin
 * closes the undo step after it as well as before (`ownStep`).
 */
export const BLOCK_ACTION_STEP = 'blockActionStep';

/**
 * The block a handle at a point of the note acts on: the innermost list
 * item the point is in, else the block of the note it is in. `pos` and
 * `inside` are what `posAtCoords` answers; for a selection, its head and the
 * selected node's start. Null where there is none, or where it is a hidden
 * tombstone.
 */
export function blockTargetAt(
  doc: ProseMirrorNode,
  { pos, inside }: { pos: number; inside: number },
): BlockTarget | null {
  const node = inside >= 0 ? doc.nodeAt(inside) : null;
  const at = node === null ? pos : node.isLeaf ? inside : inside + 1;
  const $pos = doc.resolve(Math.max(0, Math.min(at, doc.content.size)));
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if (isListItem($pos.node(depth))) return { pos: $pos.before(depth), node: $pos.node(depth) };
  }
  const found =
    $pos.depth >= 1
      ? { pos: $pos.before(1), node: $pos.node(1) }
      : $pos.nodeAfter === null
        ? null
        : { pos: $pos.pos, node: $pos.nodeAfter };
  return found === null || isTombstone(found.node) ? null : found;
}

/** The block the selection is in, or the block it selects whole. */
export function blockTargetOfSelection(state: EditorState): BlockTarget | null {
  const { selection, doc } = state;
  if (selection instanceof NodeSelection && selection.node.isBlock) {
    return blockTargetAt(doc, { pos: selection.from, inside: selection.from });
  }
  return blockTargetAt(doc, { pos: selection.head, inside: -1 });
}

/** What an action does: an edit to the note, or a highlight's removal by the note's own write. */
export type BlockChange = { readonly highlight: string } | { readonly edit: Transaction };

/**
 * What `action` on `target` does, or null where it does nothing (the first
 * block moved up). `isHighlight` says which blocks are the note's highlights.
 */
export function blockChange(
  state: EditorState,
  { target, action, isHighlight }: BlockActionRequest,
): BlockChange | null {
  const edit = (tr: Transaction | null) => (tr === null ? null : { edit: tr });
  switch (action) {
    case 'addAbove':
      return edit(insertBlock(state, target, 'above'));
    case 'addBelow':
      return edit(insertBlock(state, target, 'below'));
    case 'duplicate':
      return edit(duplicateBlock(state, target));
    case 'moveUp':
      return edit(moveBlock(state, target, -1));
    case 'moveDown':
      return edit(moveBlock(state, target, 1));
    case 'delete':
      return blockDeletion(state, target, isHighlight);
  }
}

/** An action asked of a block, and which blocks are highlights. */
export interface BlockActionRequest {
  readonly target: BlockTarget;
  readonly action: BlockAction;
  readonly isHighlight: (node: ProseMirrorNode) => boolean;
}

/** Whether `target` is still the block at its place in `doc`: the note may have changed since. */
export function stillThere(doc: ProseMirrorNode, target: BlockTarget): boolean {
  return target.pos <= doc.content.size && doc.nodeAt(target.pos) === target.node;
}

/**
 * A transaction that is a step of its own to undo — closed off from the typing
 * before it here, and from the typing after it by the handle's plugin, which
 * reads `BLOCK_ACTION_STEP` — and scrolls to what it changed.
 */
const ownStep = (tr: Transaction): Transaction =>
  closeHistory(tr).setMeta(BLOCK_ACTION_STEP, true).scrollIntoView();

/**
 * An empty block above or below `target`, with the caret in it: a paragraph
 * beside a block of the note, an empty item beside a list item.
 */
export function insertBlock(
  state: EditorState,
  target: BlockTarget,
  side: 'above' | 'below',
): Transaction | null {
  const empty = isListItem(target.node)
    ? target.node.type.createAndFill()
    : (state.schema.nodes['paragraph']?.create() ?? null);
  if (empty === null) return null;
  const at = side === 'above' ? target.pos : target.pos + target.node.nodeSize;
  const tr = state.tr.insert(at, empty);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
  return ownStep(tr);
}

/**
 * A copy of `target` after it, cleaned as a paste is: null when the copy
 * keeps nothing to show (a block that was only a marker).
 */
export function duplicateBlock(state: EditorState, target: BlockTarget): Transaction | null {
  const copied = copiedAsPasted(new Slice(Fragment.from(target.node), 0, 0));
  const copy = withoutIdsHeldBy(state.doc, copied).content;
  if (copy.childCount === 0) return null;
  const at = target.pos + target.node.nodeSize;
  const tr = state.tr.insert(at, copy);
  tr.setSelection(selectionInBlockAt(tr.doc, at));
  return ownStep(tr);
}

/**
 * `target` moved past the next block above it (`-1`) or below it (`1`) in
 * the same list or note; null at the end of what it is in. The selection
 * moves with it. Hidden tombstones never move: the block passes the visible
 * block and the run of tombstones beyond it — above it on the way up, below
 * it on the way down — so a move up and then down (or down and then up)
 * gives the note back exactly as it was, every tombstone where it sat.
 */
export function moveBlock(
  state: EditorState,
  target: BlockTarget,
  direction: -1 | 1,
): Transaction | null {
  const $target = state.doc.resolve(target.pos);
  const parent = $target.parent;
  const tombstoneAt = (index: number) =>
    parent.maybeChild(index) !== null && isTombstone(parent.child(index));
  let passed = $target.index() + direction;
  while (tombstoneAt(passed)) passed += direction;
  if (parent.maybeChild(passed) === null) return null;
  let beyond = passed + direction;
  while (tombstoneAt(beyond)) beyond += direction;
  const size = target.node.nodeSize;
  // Up: before the first of the run passed. Down: after the last of it, once the block is out.
  const at = direction < 0 ? $target.posAtIndex(beyond + 1) : $target.posAtIndex(beyond) - size;
  const tr = state.tr.delete(target.pos, target.pos + size).insert(at, target.node);
  tr.setSelection(movedSelection(state.selection, target, at, tr.doc));
  return ownStep(tr);
}

/**
 * What deleting `target` is: a highlight's removal, by the literature note's
 * own write (its id), or an edit to the note. A list item that is its list's
 * only one takes the list with it; the last block the person can see leaves
 * an empty paragraph with the caret in it, as a note always holds somewhere
 * to type — a hidden tombstone is no such place.
 */
export function blockDeletion(
  state: EditorState,
  target: BlockTarget,
  isHighlight: (node: ProseMirrorNode) => boolean,
): BlockChange {
  const id = target.node.attrs[BLOCK_ANCHOR_ATTR];
  if (typeof id === 'string' && isHighlight(target.node)) return { highlight: id };
  return { edit: deleteBlock(state, target) };
}

function deleteBlock(state: EditorState, target: BlockTarget): Transaction {
  let { pos, node } = target;
  let $pos = state.doc.resolve(pos);
  while ($pos.depth > 0 && $pos.parent.childCount === 1) {
    pos = $pos.before();
    node = $pos.parent;
    $pos = state.doc.resolve(pos);
  }
  const tr = state.tr;
  const paragraph = state.schema.nodes['paragraph'];
  if ($pos.depth === 0 && visibleBlocksIn(state.doc) === 1 && paragraph !== undefined) {
    tr.replaceWith(pos, pos + node.nodeSize, paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    return ownStep(tr);
  }
  tr.delete(pos, pos + node.nodeSize);
  const $at = tr.doc.resolve(Math.min(pos, tr.doc.content.size));
  tr.setSelection(
    Selection.findFrom($at, 1, true) ?? Selection.findFrom($at, -1, true) ?? Selection.near($at),
  );
  return ownStep(tr);
}

/** How many blocks of the note the person can see: all but its hidden tombstones. */
function visibleBlocksIn(doc: ProseMirrorNode): number {
  let count = 0;
  doc.forEach((node) => {
    if (!isTombstone(node)) count += 1;
  });
  return count;
}

/** The caret at the start of the block at `at`, or the block selected whole when it has no text. */
function selectionInBlockAt(doc: ProseMirrorNode, at: number): Selection {
  const block = doc.nodeAt(at);
  if (block !== null && block.isAtom && NodeSelection.isSelectable(block)) {
    return NodeSelection.create(doc, at);
  }
  return Selection.findFrom(doc.resolve(at), 1, true) ?? Selection.near(doc.resolve(at));
}

/** The selection as it was within `target`, now at `at`; elsewhere, left where it maps to. */
function movedSelection(
  selection: Selection,
  target: BlockTarget,
  at: number,
  doc: ProseMirrorNode,
): Selection {
  const shift = at - target.pos;
  if (selection instanceof NodeSelection && selection.from === target.pos) {
    return NodeSelection.create(doc, at);
  }
  const end = target.pos + target.node.nodeSize;
  if (selection.from > target.pos && selection.to < end) {
    return TextSelection.create(doc, selection.anchor + shift, selection.head + shift);
  }
  return selectionInBlockAt(doc, at);
}
