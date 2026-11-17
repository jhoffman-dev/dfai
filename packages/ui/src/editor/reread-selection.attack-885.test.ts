// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { undoDepth } from '@tiptap/pm/history';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { AllSelection, NodeSelection, Selection, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { EditorDocument } from '@dfai/domain';
import { showAsRead } from './block-anchor.ts';
import { selectionAfterReread } from './reread-selection.ts';
import { createEditorExtensions } from './extensions.ts';

/*
 * Attack on PR #885 (#877): a re-read carries the selection by line and offset.
 * A re-read must never throw, never leave a selection outside the new note,
 * never write (no update, no undo step), and keep the caret on its own line.
 */

/** mulberry32: a seeded random source, so every run draws the same notes. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Block = Record<string, unknown>;
type Random = () => number;

const pick = <T>(random: Random, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)]!;
const text = (value: string) => (value === '' ? {} : { content: [{ type: 'text', text: value }] });
const paragraph = (value: string): Block => ({ type: 'paragraph', ...text(value) });

// Few words, so lines repeat: duplicates and empty lines are the hard cases.
const WORDS = ['', 'alpha', 'beta', 'alpha', 'gamma delta', 'x', 'the plan.'];

function blockOf(random: Random): Block {
  const words = () => pick(random, WORDS);
  const item = (type: string, nested: boolean): Block => ({
    type,
    ...(type === 'taskItem' ? { attrs: { checked: random() < 0.5 } } : {}),
    content: [
      paragraph(words()),
      ...(nested ? [{ type: 'bulletList', content: [item('listItem', false)] }] : []),
    ],
  });
  const cell = (type: string): Block => ({ type, content: [paragraph(words())] });
  switch (Math.floor(random() * 11)) {
    case 0:
      return { type: 'heading', attrs: { level: 2 }, ...text(words()) };
    case 1:
      return {
        type: 'bulletList',
        content: [item('listItem', random() < 0.5), item('listItem', false)],
      };
    case 2:
      return { type: 'orderedList', content: [item('listItem', false), item('listItem', false)] };
    case 3:
      return { type: 'taskList', content: [item('taskItem', false), item('taskItem', false)] };
    case 4:
      return { type: 'codeBlock', ...text(`${words()}\n${words()}\n${words()}`) };
    case 5:
      return { type: 'blockquote', content: [paragraph(words())] };
    case 6:
      return {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('tableHeader'), cell('tableHeader')] },
          { type: 'tableRow', content: [cell('tableCell'), cell('tableCell')] },
          { type: 'tableRow', content: [cell('tableCell'), cell('tableCell')] },
        ],
      };
    case 7:
      return { type: 'image', attrs: { src: 'a.png' } };
    case 8:
      return { type: 'horizontalRule' };
    default:
      return paragraph(words());
  }
}

/** A changed copy of `blocks`, as another tool might save it. */
function edited(random: Random, blocks: Block[]): Block[] {
  const after = blocks.map((block) => structuredClone(block));
  const kind = random();
  if (kind < 0.04) return [];
  if (kind < 0.08) return Array.from({ length: Math.floor(random() * 10) }, () => blockOf(random));
  const edits = 1 + Math.floor(random() * 4);
  for (let n = 0; n < edits; n += 1) {
    const at = Math.floor(random() * (after.length + 1));
    const op = Math.floor(random() * 5);
    if (op === 0 || after.length === 0) after.splice(at, 0, blockOf(random));
    else if (op === 1) after.splice(Math.min(at, after.length - 1), 1);
    else if (op === 2) {
      const [moved] = after.splice(Math.min(at, after.length - 1), 1);
      after.splice(Math.floor(random() * (after.length + 1)), 0, moved!);
    } else if (op === 3) {
      const source = after[Math.min(at, after.length - 1)]!;
      after.splice(at, 0, structuredClone(source));
    } else {
      const index = Math.min(at, after.length - 1);
      const current = after[index]!;
      const line = current.type === 'paragraph' ? textOfBlock(current) : pick(random, WORDS);
      const cut = Math.floor(random() * (line.length + 1));
      const insert = pick(random, ['', 'NEW ', 'zz', 'alpha']);
      const dropped = Math.floor(random() * 3);
      after[index] = paragraph(line.slice(0, cut) + insert + line.slice(cut + dropped));
    }
  }
  return after;
}

function textOfBlock(block: Block): string {
  const content = block.content as { text?: string }[] | undefined;
  return content?.[0]?.text ?? '';
}

const docOf = (blocks: Block[]) =>
  ({
    type: 'doc',
    content: blocks.length === 0 ? [paragraph('')] : blocks,
  }) as unknown as EditorDocument;

let editor: Editor;

function mount(content: EditorDocument): Editor {
  return new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: createEditorExtensions({
      suggest: () => [],
      onView: () => {},
      onSlashView: () => {},
      suggestTags: () => [],
      onTagView: () => {},
      onOpenTag: null,
      offerLink: false,
      loadImage: async () => null,
      embedImage: null,
    }),
    content: content as object,
    editorProps: { attributes: { tabindex: '-1' } },
  });
}

afterEach(() => {
  editor?.destroy();
  document.body.replaceChildren();
});

/** A selection somewhere in `doc`, of a seeded kind. */
function selectionIn(random: Random, doc: ProseMirrorNode): Selection {
  const inline: number[] = [];
  const nodes: number[] = [];
  const cells: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) for (let i = 0; i <= node.content.size; i += 1) inline.push(pos + 1 + i);
    if (NodeSelection.isSelectable(node) && !node.isText) nodes.push(pos);
    // Cells of the first table only: a cell selection spans one table.
    if (node.type.name === 'table' && cells.length === 0)
      node.descendants((cell, offset) => {
        if (cell.type.spec.tableRole === 'cell' || cell.type.spec.tableRole === 'header_cell')
          cells.push(pos + 1 + offset);
        return cell.type.spec.tableRole === 'row';
      });
    return true;
  });
  const kind = random();
  if (kind < 0.05) return new AllSelection(doc);
  if (kind < 0.15 && nodes.length > 0) return NodeSelection.create(doc, pick(random, nodes));
  if (kind < 0.22 && cells.length > 1)
    return CellSelection.create(doc, pick(random, cells), pick(random, cells));
  if (kind < 0.55 && inline.length > 0)
    return TextSelection.between(
      doc.resolve(pick(random, inline)),
      doc.resolve(pick(random, inline)),
    );
  if (inline.length > 0) return TextSelection.create(doc, pick(random, inline));
  return Selection.atStart(doc);
}

describe('showAsRead never throws, never writes, never leaves the note (#885 property)', () => {
  // 3,000 editor round-trips take ~4.6 s alone and ~30 s on a CI shard with
  // coverage, so they run as six tests of 500 seeds, each with room to spare.
  const SEEDS_PER_TEST = 500;
  for (let first = 1; first <= 3000; first += SEEDS_PER_TEST) {
    const last = first + SEEDS_PER_TEST - 1;
    it(
      `holds for seeded notes, selections and outside edits ${first}–${last}`,
      { timeout: 30_000 },
      () => {
        const failures: string[] = [];
        editor = mount(docOf([paragraph('')]));
        const updates = vi.fn();
        editor.on('update', updates);
        for (let seed = first; seed <= last && failures.length < 5; seed += 1) {
          const random = seeded(seed);
          const before = Array.from({ length: Math.floor(random() * 41) }, () => blockOf(random));
          const after = edited(random, before);
          editor.commands.setContent(docOf(before) as object, { emitUpdate: false });
          editor.view.dispatch(editor.state.tr.setSelection(selectionIn(random, editor.state.doc)));
          const depth = undoDepth(editor.state);
          const updatesBefore = updates.mock.calls.length;
          try {
            showAsRead(editor, docOf(after));
          } catch (error) {
            failures.push(`seed ${seed}: threw ${String(error)}`);
            continue;
          }
          const { doc, selection } = editor.state;
          const size = doc.content.size;
          const inside = (pos: number) => pos >= 0 && pos <= size;
          if (!inside(selection.from) || !inside(selection.to))
            failures.push(
              `seed ${seed}: selection ${selection.from}-${selection.to} outside ${size}`,
            );
          else if (
            selection instanceof TextSelection &&
            (!selection.$anchor.parent.inlineContent || !selection.$head.parent.inlineContent)
          )
            failures.push(`seed ${seed}: text selection outside text`);
          try {
            Selection.fromJSON(doc, selection.toJSON());
          } catch (error) {
            failures.push(`seed ${seed}: selection not valid in the new note: ${String(error)}`);
          }
          if (updates.mock.calls.length !== updatesBefore)
            failures.push(`seed ${seed}: emitted update`);
          if (undoDepth(editor.state) !== depth) failures.push(`seed ${seed}: added an undo step`);
        }
        expect(failures).toEqual([]);
      },
    );
  }
});

describe('showAsRead keeps the caret on its own line (#885 exact places)', () => {
  const note = (...lines: string[]) => docOf(lines.map(paragraph));

  /** The position `offset` into the `nth` (0-based) line reading `value`. */
  function at(value: string, offset: number, nth = 0): number {
    const found: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === value) found.push(pos + 1 + offset);
      return true;
    });
    if (found[nth] === undefined) throw new Error(`No line ${nth} reads "${value}".`);
    return found[nth]!;
  }

  const caret = (pos: number) =>
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));

  beforeEach(() => {
    editor = mount(note('A line.', 'B line.', 'C line.'));
  });

  it('keeps the caret on its line when a line is added above and the caret line is edited', () => {
    // The other tool adds a line on top and appends to the caret's line in one save.
    caret(at('B line.', 2));
    showAsRead(editor, note('Theirs, on top.', 'A line.', 'B line, and more.', 'C line.'));

    expect(editor.state.selection.head).toBe(at('B line, and more.', 2));
  });

  it('keeps the caret on the second of two identical lines when a line is added above and another changed', () => {
    editor.commands.setContent(note('Same.', 'Same.', 'End.') as object);
    caret(at('Same.', 3, 1));
    showAsRead(editor, note('Theirs, on top.', 'Same.', 'Same.', 'End, edited.'));

    expect(editor.state.selection.head).toBe(at('Same.', 3, 1));
  });

  it('keeps the caret on the second of two identical lines when a line is added above', () => {
    editor.commands.setContent(note('Same.', 'Same.', 'End.') as object);
    caret(at('Same.', 3, 1));
    showAsRead(editor, note('Theirs, on top.', 'Same.', 'Same.', 'End.'));

    expect(editor.state.selection.head).toBe(at('Same.', 3, 1));
  });

  it('puts the caret on a neighbour, not the note end, when its line is removed among changes', () => {
    caret(at('B line.', 2));
    showAsRead(editor, note('A line.', 'C line, edited.', 'D.', 'E.'));

    expect(editor.state.selection.head).toBeLessThan(at('D.', 0));
  });

  it('keeps a range across a removed line inside the note', () => {
    editor.commands.setContent(note('A line.', 'B line.', 'C line.', 'D line.') as object);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, at('A line.', 2), at('C line.', 2)),
      ),
    );
    showAsRead(editor, note('A line.', 'C line.', 'D line.'));

    expect(editor.state.selection.anchor).toBe(at('A line.', 2));
    expect(editor.state.selection.head).toBe(at('C line.', 2));
  });

  it('goes from many lines to empty and back without throwing', () => {
    caret(at('C line.', 4));
    showAsRead(editor, note(''));
    showAsRead(editor, note('A line.', 'B line.', 'C line.'));

    expect(editor.state.selection.head).toBe(at('A line.', 0));
  });

  it('keeps the caret in the table when its cell row is deleted', () => {
    const table = (rows: string[][]) => ({
      type: 'table',
      content: rows.map((row) => ({
        type: 'tableRow',
        content: row.map((value) => ({ type: 'tableCell', content: [paragraph(value)] })),
      })),
    });
    editor.commands.setContent(
      docOf([
        paragraph('Above.'),
        table([
          ['h1', 'h2'],
          ['r1', 'mid'],
          ['r2', 'low'],
        ]),
        paragraph('Below.'),
      ]) as object,
    );
    caret(at('mid', 2));
    showAsRead(
      editor,
      docOf([
        paragraph('Above.'),
        table([
          ['h1', 'h2'],
          ['r2', 'low'],
        ]),
        paragraph('Below.'),
      ]),
    );

    const { $head } = editor.state.selection;
    expect($head.node(1).type.name).toBe('table');
  });
});

describe('showAsRead speed on a long note with many identical lines (#885)', () => {
  /** The note, the caret in its middle, and the note with the line after it changed. */
  function longNote(lines: number) {
    const content = Array.from({ length: lines }, (_, i) =>
      paragraph(i % 3 === 0 ? '' : 'Same line.'),
    );
    const middle = Math.floor(lines / 2);
    const changed = content.map((block, i) => (i === middle + 1 ? paragraph('Changed.') : block));
    return { content, middle, changed };
  }

  function caretOnLine(index: number): void {
    let pos = 0;
    editor.state.doc.forEach((_node, offset, i) => {
      if (i === index) pos = offset + 1;
    });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
  }

  /** Median of five: one showAsRead, and one plain setContent of the same change. */
  function timeOne(lines: number): { reread: number; plain: number; mapping: number } {
    const { content, middle, changed } = longNote(lines);
    const reread: number[] = [];
    const plain: number[] = [];
    const mapping: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      editor?.destroy();
      editor = mount(docOf(content));
      caretOnLine(middle);
      let started = performance.now();
      showAsRead(editor, docOf(changed));
      reread.push(performance.now() - started);
      editor.commands.setContent(docOf(content) as object, { emitUpdate: false });
      caretOnLine(middle);
      started = performance.now();
      editor.commands.setContent(docOf(changed) as object, { emitUpdate: false });
      plain.push(performance.now() - started);
      const before = editor.schema.nodeFromJSON(docOf(content));
      const after = editor.schema.nodeFromJSON(docOf(changed));
      const selection = TextSelection.create(before, 3 * middle + 1);
      started = performance.now();
      selectionAfterReread(selection, { before, after });
      mapping.push(performance.now() - started);
    }
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[2]!;
    return { reread: median(reread), plain: median(plain), mapping: median(mapping) };
  }

  // Ten mounts of up to 5,000 lines take ~2.6 s here and past 5 s on a CI shard with coverage.
  it('re-reads 1,000 and 5,000 lines with one changed', { timeout: 30_000 }, () => {
    const small = timeOne(1000);
    const large = timeOne(5000);
    const ms = (t: { reread: number; plain: number; mapping: number }) =>
      `showAsRead ${t.reread.toFixed(1)} ms, plain setContent ${t.plain.toFixed(1)} ms, mapping alone ${t.mapping.toFixed(2)} ms`;
    process.stdout.write(`[attack-885] 1,000 lines: ${ms(small)}; 5,000 lines: ${ms(large)}\n`);
    expect(large.mapping).toBeGreaterThan(0);
  });
});

describe('showAsRead in a focused editor: the next page caret is read (#885)', () => {
  function textOf(value: string): Text {
    const line = [...editor.view.dom.querySelectorAll('p')].find((p) => p.textContent === value);
    const node = line?.firstChild;
    if (!(node instanceof Text)) throw new Error(`No line reads "${value}".`);
    return node;
  }

  function pageCaret(node: Text, offset: number): void {
    document.getSelection()?.collapse(node, offset);
    document.dispatchEvent(new Event('selectionchange'));
  }

  it('reads a click back on the spot the caret was on before the re-read', () => {
    editor = mount(docOf([paragraph('Line 1.'), paragraph('Line 2 of the plan.')]));
    editor.view.dom.focus();
    const line = textOf('Line 2 of the plan.');
    pageCaret(line, 12);
    const changed = 'Line 2 of a plan.';
    showAsRead(editor, docOf([paragraph('Line 1.'), paragraph(changed)]));
    expect(editor.view.hasFocus()).toBe(true);
    // The caret was carried elsewhere; the person clicks back where it was.
    caretOnFirstLine();
    pageCaret(textOf(changed), 12);

    let expected = -1;
    editor.state.doc.forEach((node, offset) => {
      if (node.textContent === changed) expected = offset + 1 + 12;
    });
    expect(editor.state.selection.head).toBe(expected);
  });

  function caretOnFirstLine(): void {
    pageCaret(textOf('Line 1.'), 2);
  }
});
