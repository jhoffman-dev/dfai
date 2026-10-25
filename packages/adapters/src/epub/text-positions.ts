/*
 * Places in a chapter's text, and the DOM positions they are (#505). A
 * chapter's text (`chapterText`) is read from its text nodes, each a run
 * that begins at an offset of it; these turn an offset into a position in
 * one of those nodes and back. The reader uses them on the parsed chapter,
 * for CFIs, and the chapter's frame uses the same ones on the chapter it
 * builds, for the selection and the highlights: this file is part of the
 * frame's script (tools/epub/frame-bootstrap.ts), so it imports only the
 * DOM's own members (`unshadowed-dom.ts`), which a book's names cannot shadow.
 */

import { childNodesOf, createRange, nodeTypeOf, ownerDocumentOf } from './unshadowed-dom.ts';

/** One text node of the chapter, and where its words begin in the chapter's text. */
export interface Run {
  readonly node: Text;
  readonly start: number;
}

/** A chapter's text nodes, in document order, and how long its text is. */
export interface TextRuns {
  readonly runs: readonly Run[];
  readonly length: number;
}

const TEXT = 3;

/** The DOM position of offset `offset` of the chapter's text: within the run it falls in, or at the next one's start. */
export function positionAt(
  chapter: TextRuns,
  offset: number,
): { node: Text; offset: number } | null {
  const { runs } = chapter;
  if (runs.length === 0) return null;
  let low = 0;
  let high = runs.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((runs[middle] as Run).start <= offset) low = middle;
    else high = middle - 1;
  }
  const run = runs[low] as Run;
  const within = offset - run.start;
  if (within < 0) return { node: run.node, offset: 0 };
  if (within <= run.node.data.length) return { node: run.node, offset: within };
  // A line break between two blocks belongs to no node: the place is where the next run begins.
  const next = runs[low + 1];
  return next === undefined
    ? { node: run.node, offset: run.node.data.length }
    : { node: next.node, offset: 0 };
}

/** A DOM range over `[start, end)` of the chapter's text, in the document its runs are of; null for a chapter with no words. */
export function rangeAt(chapter: TextRuns, start: number, end: number): Range | null {
  const from = positionAt(chapter, start);
  const to = positionAt(chapter, end);
  if (from === null || to === null) return null;
  const range = createRange(from.node.ownerDocument);
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/**
 * The offset of the chapter's text a DOM position is at: within a text node
 * of it, or before the first word at or after a position between nodes.
 */
export function offsetAt(chapter: TextRuns, node: Node, offset: number): number {
  if (nodeTypeOf(node) === TEXT) {
    const run = chapter.runs.find((each) => each.node === node);
    if (run !== undefined) return run.start + Math.min(offset, run.node.data.length);
  }
  const doc = ownerDocumentOf(node);
  // A document itself has no owner, and no place among its chapter's words.
  if (doc === null) return chapter.length;
  const probe = createRange(doc);
  probe.setStart(node, Math.min(offset, childCount(node)));
  // The first run whose start is not before the position; past them all, the end of the text.
  const after = chapter.runs.find((run) => probe.comparePoint(run.node, 0) >= 0);
  return after?.start ?? chapter.length;
}

const childCount = (node: Node): number =>
  nodeTypeOf(node) === TEXT ? (node as Text).data.length : childNodesOf(node).length;
