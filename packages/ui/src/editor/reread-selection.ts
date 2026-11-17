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

/** The old line and the stretch of changed lines it was in, before and after. */
interface Stretch {
  was: Line[];
  own: number;
  changed: Line[];
}

/** A line's identity as `eq` sees it: its kind, attributes, marks and text. */
const keyOf = (node: ProseMirrorNode) => JSON.stringify(node.toJSON());

/**
 * `old` itself among the changed lines, unedited: of the lines reading the
 * same, the one of the same rank (the second of two blank lines stays the
 * second), with where it lies in the stretch. Only when every such line is
 * still there: with one gone, the rank no longer says which.
 */
function sameLine(
  old: ProseMirrorNode,
  { was, own, changed }: Stretch,
): { line: Line; distance: number; certain: boolean } | undefined {
  const rank = was.slice(0, own).filter((line) => line.node.eq(old)).length;
  const twins = rank + was.slice(own).filter((line) => line.node.eq(old)).length;
  const copies = changed
    .map((line, i) => ({ line, distance: Math.abs(i - own) }))
    .filter(({ line }) => line.node.eq(old));
  if (copies.length >= twins) return { ...copies[rank]!, certain: true };
  const nearest = copies.sort((a, b) => a.distance - b.distance)[0];
  return nearest === undefined ? undefined : { ...nearest, certain: false };
}

/**
 * How much text `old` and `now` share: what they start with and end with
 * alike, as plain text, so a word made bold still counts as the same words.
 */
function shared(old: ProseMirrorNode, now: ProseMirrorNode): number {
  const a = old.textContent;
  const b = now.textContent;
  const shorter = Math.min(a.length, b.length);
  let start = 0;
  while (start < shorter && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < shorter - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  return start + end;
}

/**
 * `old` as edited: the changed line, not another old line untouched, that
 * shares the most text with it, the nearest to its place on a tie. A line
 * that is `old` with another kind or marks (made a heading, a word made bold)
 * is not untouched: only the other old lines, compared whole, are left out.
 */
function editedLine(
  old: ProseMirrorNode,
  { was, own, changed }: Stretch,
): { line: Line; distance: number } | undefined {
  const untouched = new Set(was.filter((_, i) => i !== own).map((line) => keyOf(line.node)));
  let best: { line: Line; score: number; distance: number } | undefined;
  changed.forEach((line, i) => {
    if (untouched.has(keyOf(line.node))) return;
    const score = shared(old, line.node);
    const distance = Math.abs(i - own);
    if (score === 0) return;
    if (
      best === undefined ||
      score > best.score ||
      (score === best.score && distance < best.distance)
    )
      best = { line, score, distance };
  });
  return best;
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

  // Among the changed lines: the same line moved, when its rank says which;
  // else that or the line edited, whichever lies nearer its place (the
  // unedited one on a tie); else the line in its place; else the line before.
  const changed = after.slice(same.start, after.length - same.end);
  const was = before.slice(same.start, before.length - same.end);
  const own = index - same.start;
  const stretch = { was, own, changed };
  const moved = sameLine(line.node, stretch);
  if (moved?.certain === true) return at(moved.line, offset);
  const edited = editedLine(line.node, stretch);
  if (moved !== undefined && (edited === undefined || moved.distance <= edited.distance))
    return at(moved.line, offset);
  const kept = edited?.line ?? changed[own];
  if (kept !== undefined) return at(kept, offsetAcross(line.node, kept.node, offset));
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
  if (selection instanceof TextSelection) {
    const anchor = place(selection.anchor);
    // A caret is one place: carried once.
    return TextSelection.between(anchor, selection.empty ? anchor : place(selection.head));
  }
  // A picked node (an image, an embed) or cells of a table come back as a
  // caret near where they were: which node is "the same" after a re-read is
  // not known, and a caret is the safe thing to type at.
  return Selection.near(place(selection.from));
}
