import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { AllSelection, Selection, TextSelection } from '@tiptap/pm/state';

/** A block of text (a paragraph, a heading, a code block) and where its text starts. */
interface Line {
  node: ProseMirrorNode;
  start: number;
}

/** The note's lines, in order. */
function linesOf(doc: ProseMirrorNode): Line[] {
  const lines: Line[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    lines.push({ node, start: pos + 1 });
    return false;
  });
  return lines;
}

/** The two notes' lines, and how many at their start and at their end are the same. */
interface LineDiff {
  before: Line[];
  after: Line[];
  same: { start: number; end: number };
}

function diffLines(before: ProseMirrorNode, after: ProseMirrorNode): LineDiff {
  const old = linesOf(before);
  const now = linesOf(after);
  const shorter = Math.min(old.length, now.length);
  let start = 0;
  while (start < shorter && old[start]!.node.eq(now[start]!.node)) start += 1;
  let end = 0;
  while (
    end < shorter - start &&
    old[old.length - 1 - end]!.node.eq(now[now.length - 1 - end]!.node)
  )
    end += 1;
  return { before: old, after: now, same: { start, end } };
}

/**
 * Where `offset` into the text of `old` falls in `now`, its line as changed:
 * the same place in words that did not change, after the new words when the
 * words around it were replaced.
 */
function offsetAcross(old: ProseMirrorNode, now: ProseMirrorNode, offset: number): number {
  const start = old.content.findDiffStart(now.content);
  const end = old.content.findDiffEnd(now.content);
  if (start === null || end === null) return Math.min(offset, now.content.size);
  // A run of the same characters is matched from both ends; take the overlap off the end.
  const overlap = Math.max(0, start - Math.min(end.a, end.b));
  if (offset <= start) return offset;
  if (offset >= end.a + overlap) return offset - end.a + end.b;
  return end.b + overlap;
}

/** The place in `diff.after` for `pos` in the old note, by its line and its offset in it. */
function placeAcross(diff: LineDiff, pos: number, size: number): number {
  const { before, after, same } = diff;
  const index = before.findIndex(
    (line) => line.start <= pos && pos <= line.start + line.node.content.size,
  );
  // Not in a line (a picked image, say): kept by number, inside the new note.
  if (index === -1) return Math.min(pos, size);
  const line = before[index]!;
  const offset = pos - line.start;
  const at = (now: Line, inLine: number) => now.start + Math.min(inLine, now.node.content.size);
  if (index < same.start) return at(after[index]!, offset);
  if (index >= before.length - same.end)
    return at(after[index - before.length + after.length]!, offset);

  // Among the changed lines: the same line moved, else the line in its place, else the line before.
  const changed = after.slice(same.start, after.length - same.end);
  const own = index - same.start;
  const moved = changed
    .map((now, i) => ({ now, distance: Math.abs(i - own) }))
    .filter(({ now }) => now.node.eq(line.node))
    .sort((a, b) => a.distance - b.distance)[0];
  if (moved !== undefined) return at(moved.now, offset);
  const inPlace = changed[own];
  if (inPlace !== undefined) return at(inPlace, offsetAcross(line.node, inPlace.node, offset));
  const previous = after[same.start + changed.length - 1];
  if (previous !== undefined) return previous.start + previous.node.content.size;
  const next = after[same.start + changed.length];
  return next === undefined ? 0 : next.start;
}

/**
 * `selection`, made in `before`, carried to `after`, the same note re-read
 * from its file (#877): each end stays on its line, at its offset in it. A
 * line gone puts it at the end of the line before (or the start of the next),
 * never at the note's end.
 */
export function selectionAfterReread(
  selection: Selection,
  notes: { before: ProseMirrorNode; after: ProseMirrorNode },
): Selection {
  const { before, after } = notes;
  if (selection instanceof AllSelection) return new AllSelection(after);
  const diff = diffLines(before, after);
  const place = (pos: number) => after.resolve(placeAcross(diff, pos, after.content.size));
  if (selection instanceof TextSelection)
    return TextSelection.between(place(selection.anchor), place(selection.head));
  return Selection.near(place(selection.from));
}
