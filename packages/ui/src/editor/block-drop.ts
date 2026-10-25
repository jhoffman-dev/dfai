import { Extension } from '@tiptap/core';
import { Fragment, Slice, type Node as ProseMirrorNode, type ResolvedPos } from '@tiptap/pm/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state';
import { dropPoint } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { TABLE_CELL_TYPES, fitsInTableCell } from '@dfai/domain';
import { isListItem } from './block-actions.ts';
import { copiedAsPasted } from './tombstone-guard.ts';

/*
 * Where a block dragged within its note lands (#569, PR #534). ProseMirror's
 * own drop puts what is dragged wherever the schema lets it, and the schema is
 * wider than the markdown the note is saved as:
 *
 * - A table cell is one line of markdown, so only a paragraph is dropped into
 *   one (`fitsInTableCell`); any other block is refused and nothing moves,
 *   rather than be written as a line it is not, or lost.
 * - A raw block — a highlight, HTML — is a block of the file itself, read
 *   nowhere else (highlight-block.ts, ADR-0043), so it lands at the top level,
 *   before or after the block the pointer is in, never inside it.
 * - A list item dropped where no list holds it is still an item of the kind
 *   of list it came from: it is wrapped in one of its own, not in the first
 *   kind the schema finds.
 * - A block dropped on itself goes nowhere, and the note is left as it is.
 * - A drop as a copy (⌥) is cleaned as a paste is (`copiedAsPasted`): its
 *   highlights made plain quotes, so the passage keeps one live highlight,
 *   then its raw blocks' markers and ids taken off.
 *
 * A drag begun elsewhere — text from another app, a file — is left to the
 * editor's own drop, as is a drag from another note.
 */

/** What a drag within the note asks at its drop. */
export interface DropRequest {
  /** Where the pointer is, in the document. */
  readonly pos: number;
  /** What is dragged, as the clipboard would carry it. */
  readonly slice: Slice;
  /** The block dragged whole — by its handle, or selected — when one was. */
  readonly dragged: NodeSelection | null;
  /** Moved out of its place, rather than copied with ⌥. */
  readonly moved: boolean;
}

/** Where a drop lands and what it puts there. */
export interface PlannedDrop {
  readonly at: number;
  readonly slice: Slice;
}

/** The drop as the note takes it, or null: refused, and nothing moves. */
export function plannedDrop(
  doc: ProseMirrorNode,
  { pos, slice, dragged, moved }: DropRequest,
): PlannedDrop | null {
  if (moved && dragged !== null && pos >= dragged.from && pos <= dragged.to) return null;
  const content = moved ? slice : copiedAsPasted(slice);
  if (content.content.childCount === 0) return null;
  const $pos = doc.resolve(pos);
  const at = holdsRawBlock(content)
    ? topLevelBoundary($pos)
    : (dropPoint(doc, pos, content) ?? pos);
  const $at = doc.resolve(at);
  if (inCell($at) && !fitsInCell(content)) return null;
  return { at, slice: inItsOwnList($at, content, dragged) };
}

const holdsRawBlock = (slice: Slice): boolean => {
  let found = false;
  slice.content.forEach((node) => {
    if (node.type.name === 'rawBlock') found = true;
  });
  return found;
};

/** `$pos` itself between blocks of the note; inside one, the nearer of its edges. */
function topLevelBoundary($pos: ResolvedPos): number {
  if ($pos.depth === 0) return $pos.pos;
  const before = $pos.before(1);
  const after = $pos.after(1);
  return $pos.pos - before <= after - $pos.pos ? before : after;
}

function inCell($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if (TABLE_CELL_TYPES.has($pos.node(depth).type.name)) return true;
  }
  return false;
}

const fitsInCell = (slice: Slice): boolean => {
  let fits = true;
  slice.content.forEach((node) => {
    if (!fitsInTableCell(node.type.name)) fits = false;
  });
  return fits;
};

/** The one block the slice is, closed on both sides, or null. */
const singleNodeOf = (slice: Slice): ProseMirrorNode | null =>
  slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1
    ? slice.content.firstChild
    : null;

/**
 * A list item dropped at `$at`, where a list takes it, as it is; where none
 * does, in a list of the kind it was dragged out of.
 */
function inItsOwnList($at: ResolvedPos, content: Slice, dragged: NodeSelection | null): Slice {
  const item = singleNodeOf(content);
  if (item === null || dragged === null || !isListItem(item)) return content;
  if ($at.parent.canReplaceWith($at.index(), $at.index(), item.type)) return content;
  const list = dragged.$from.parent;
  return new Slice(Fragment.from(list.type.create(null, item)), 0, 0);
}

/**
 * ProseMirror's own drop, with the note's rules (`plannedDrop`) deciding the
 * place and the slice. Mirrors prosemirror-view 1.42's handleDrop otherwise.
 */
function dropWithinNote(view: EditorView, event: DragEvent, slice: Slice, moved: boolean): boolean {
  const dragging = view.dragging;
  // Not a drag begun in this note: the editor's own drop, and the drops after this one, take it.
  if (dragging === null || slice.size === 0) return false;
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (at === null) return false;
  const dragged = draggedNodeOf(dragging);
  const planned = plannedDrop(view.state.doc, { pos: at.pos, slice, dragged, moved });
  event.preventDefault();
  if (planned === null) return true;
  const tr = view.state.tr;
  if (moved) {
    if (dragged !== null) dragged.replace(tr);
    else tr.deleteSelection();
  }
  const pos = tr.mapping.map(planned.at);
  const only = singleNodeOf(planned.slice);
  const beforeInsert = tr.doc;
  if (only !== null) tr.replaceRangeWith(pos, pos, only);
  else tr.replaceRange(pos, pos, planned.slice);
  if (tr.doc.eq(beforeInsert)) return true;
  selectDropped(view, tr, { insertAt: planned.at, pos, only });
  view.focus();
  view.dispatch(tr.setMeta('uiEvent', 'drop'));
  return true;
}

/**
 * The block selected whole that a drag carries, when it carries one.
 * prosemirror-view keeps it on `dragging` as `node` (and deletes it on a
 * move); its types leave the field out.
 */
function draggedNodeOf(dragging: NonNullable<EditorView['dragging']>): NodeSelection | null {
  const { node } = dragging as { node?: unknown };
  return node instanceof NodeSelection ? node : null;
}

/**
 * Selects what the drop put in, not the block it was copied from: the one
 * node, or the stretch inserted. `insertAt` is the place before the move took
 * the block out, `pos` the same place after.
 */
function selectDropped(
  view: EditorView,
  tr: Transaction,
  { insertAt, pos, only }: { insertAt: number; pos: number; only: ProseMirrorNode | null },
): void {
  const $pos = tr.doc.resolve(pos);
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

/** The drop of a block dragged within its note, by the note's rules. */
export const BlockDrop = Extension.create({
  name: 'blockDrop',

  addProseMirrorPlugins() {
    return [new Plugin({ key: new PluginKey('blockDrop'), props: { handleDrop: dropWithinNote } })];
  },
});
