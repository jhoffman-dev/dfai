// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor, getSchema } from '@tiptap/core';
import { undoDepth } from '@tiptap/pm/history';
import { Fragment, Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model';
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
      // An image is inline in the app's schema: it sits in a line.
      return { type: 'paragraph', content: [{ type: 'image', attrs: { src: 'a.png' } }] };
    case 8:
      return { type: 'horizontalRule' };
    default:
      return paragraph(words());
  }
}

/** A changed copy of `blocks`, as another tool might save it. */
function edited(random: Random, blocks: Block[]): Block[] {
  // Blocks are only spliced and replaced, never changed in place, so they are shared.
  const after = [...blocks];
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
      after.splice(at, 0, source);
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

/** The app's own editor extensions, with nothing to suggest or load. */
function extensions() {
  return createEditorExtensions({
    suggest: () => [],
    onView: () => {},
    onSlashView: () => {},
    suggestTags: () => [],
    onTagView: () => {},
    onOpenTag: null,
    offerLink: false,
    loadImage: async () => null,
    embedImage: null,
  });
}

function mount(content: EditorDocument): Editor {
  return new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: extensions(),
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

/** What is wrong with `selection` as a selection in `doc`, or null. */
function wrongIn(selection: Selection, doc: ProseMirrorNode): string | null {
  const size = doc.content.size;
  const inside = (pos: number) => pos >= 0 && pos <= size;
  if (!inside(selection.from) || !inside(selection.to))
    return `selection ${selection.from}-${selection.to} outside ${size}`;
  if (
    selection instanceof TextSelection &&
    (!selection.$anchor.parent.inlineContent || !selection.$head.parent.inlineContent)
  )
    return 'text selection outside text';
  try {
    Selection.fromJSON(doc, selection.toJSON());
  } catch (error) {
    return `selection not valid in the new note: ${String(error)}`;
  }
  return null;
}

/** A seeded note, a selection in it, and the note as another tool changed it. */
function seededCase(seed: number, schema: Schema) {
  const random = seeded(seed);
  const before = Array.from({ length: Math.floor(random() * 41) }, () => blockOf(random));
  const after = edited(random, before);
  const doc = schema.nodeFromJSON(docOf(before));
  return { doc, after, selection: selectionIn(random, doc) };
}

describe('the re-read mapping never throws and never leaves the note (#885 property)', () => {
  it('holds for 3,000 seeded notes, selections and outside edits, without an editor', () => {
    const schema = getSchema(extensions());
    const failures: string[] = [];
    for (let seed = 1; seed <= 3000 && failures.length < 5; seed += 1) {
      const { doc, after, selection } = seededCase(seed, schema);
      const now = schema.nodeFromJSON(docOf(after));
      // A note the generator nested wrongly would prove nothing.
      doc.check();
      now.check();
      try {
        const mapped = selectionAfterReread(selection, { before: doc, after: now });
        const wrong = wrongIn(mapped, now);
        if (wrong !== null) failures.push(`seed ${seed}: ${wrong}`);
      } catch (error) {
        failures.push(`seed ${seed}: threw ${String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

/** A block of each kind `blockOf` draws: its switch reads the first draw, so a constant picks it. */
const EVERY_BLOCK = Array.from({ length: 11 }, (_, k) => blockOf(() => (k + 0.5) / 11));

/**
 * A selection of each kind `selectionIn` draws: all, a node, cells, a range, a
 * caret. The first draw picks the kind; the next ones its ends, kept apart.
 */
const SELECTION_DRAWS = [[0.02], [0.1], [0.2, 0.1, 0.9], [0.4, 0.1, 0.9], [0.8]];

/** A random source that gives `values` over and over. */
function drawing(values: number[]): Random {
  let next = 0;
  return () => values[next++ % values.length]!;
}

describe('showAsRead never throws, never writes, never leaves the note (#885 property)', () => {
  /** Shows `before` with the selection `draw` picks, re-reads `after`, and says what went wrong. */
  function reread(before: Block[], after: Block[], draw: Random): string | null {
    editor.commands.setContent(docOf(before) as object, { emitUpdate: false });
    editor.view.dispatch(editor.state.tr.setSelection(selectionIn(draw, editor.state.doc)));
    const depth = undoDepth(editor.state);
    const updates = vi.fn();
    editor.on('update', updates);
    try {
      showAsRead(editor, docOf(after));
    } catch (error) {
      return `threw ${String(error)}`;
    } finally {
      editor.off('update', updates);
    }
    if (updates.mock.calls.length > 0) return 'emitted update';
    if (undoDepth(editor.state) !== depth) return 'added an undo step';
    return wrongIn(editor.state.selection, editor.state.doc);
  }

  it('draws every kind of block and of selection in the listed cases', () => {
    const doc = getSchema(extensions()).nodeFromJSON(docOf(EVERY_BLOCK));
    doc.check();
    const drawn = new Set<string>();
    doc.descendants((node) => {
      drawn.add(node.type.name);
    });
    for (const kind of [
      'heading',
      'bulletList',
      'orderedList',
      'taskList',
      'codeBlock',
      'blockquote',
      'table',
      'image',
      'horizontalRule',
      'paragraph',
    ])
      expect(drawn, kind).toContain(kind);
    const kinds = SELECTION_DRAWS.map((draw) => {
      const selection = selectionIn(drawing(draw), doc);
      if (selection instanceof TextSelection) return selection.empty ? 'caret' : 'range';
      if (selection instanceof AllSelection) return 'all';
      if (selection instanceof NodeSelection) return 'node';
      return selection instanceof CellSelection ? 'cells' : 'other';
    });
    expect(kinds).toEqual(['all', 'node', 'cells', 'range', 'caret']);
  });

  it('holds for every kind of block and selection, through the editor', () => {
    editor = mount(docOf([paragraph('')]));
    // Every block, with the first and last swapped, one dropped and a line added.
    const after = [
      EVERY_BLOCK.at(-1)!,
      ...EVERY_BLOCK.slice(2, -1),
      paragraph('NEW'),
      EVERY_BLOCK[0]!,
    ];
    const failures = SELECTION_DRAWS.flatMap((draw) => {
      const wrong = reread(EVERY_BLOCK, after, drawing(draw));
      return wrong === null ? [] : [`draw ${draw.join()}: ${wrong}`];
    });
    expect(failures).toEqual([]);
  });

  it('holds for 30 seeded notes, selections and outside edits, through the editor', () => {
    editor = mount(docOf([paragraph('')]));
    const failures: string[] = [];
    for (let seed = 1; seed <= 30; seed += 1) {
      const random = seeded(seed);
      const before = Array.from({ length: Math.floor(random() * 41) }, () => blockOf(random));
      const after = edited(random, before);
      const wrong = reread(before, after, random);
      if (wrong !== null) failures.push(`seed ${seed}: ${wrong}`);
    }
    expect(failures).toEqual([]);
  });
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

  describe('when the caret’s line keeps its text but not its kind or marks', () => {
    beforeEach(() => {
      editor.commands.setContent(note('Top.', 'Order chairs', 'Notes', 'End.') as object);
      caret(at('Order chairs', 3));
    });

    it('keeps the caret on its line when the line is made a heading', () => {
      showAsRead(
        editor,
        docOf([
          paragraph('Top.'),
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Order chairs' }],
          },
          paragraph('Notes about chairs'),
          paragraph('End.'),
        ]),
      );

      expect(editor.state.selection.head).toBe(at('Order chairs', 3));
      expect(editor.state.selection.$head.parent.type.name).toBe('heading');
    });

    it('keeps the caret on its line when a word on it is made bold', () => {
      showAsRead(
        editor,
        docOf([
          paragraph('Top.'),
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Order ' },
              { type: 'text', text: 'chairs', marks: [{ type: 'bold' }] },
            ],
          },
          paragraph('Notes about chairs'),
          paragraph('End.'),
        ]),
      );

      expect(editor.state.selection.head).toBe(at('Order chairs', 3));
    });
  });

  it('keeps the caret on its retyped line when another line, untouched, reads as it did', () => {
    editor.commands.setContent(
      note('Top.', 'Order chairs', 'Mid.', 'Order chairs', 'End.') as object,
    );
    caret(at('Order chairs', 3, 0));
    showAsRead(
      editor,
      note('Theirs, on top.', 'Order the chairs', 'Mid.', 'Order chairs', 'End, edited.'),
    );

    expect(editor.state.selection.head).toBe(at('Order the chairs', 3));
  });

  it('does not send the caret to a far line that shares a character with its removed line', () => {
    editor.commands.setContent(note('Top.', 'Buy milk.', 'x', 'y', 'z', 'w', 'Last.') as object);
    caret(at('Buy milk.', 'Buy milk.'.length));
    showAsRead(editor, note('Top.', 'x', 'y', 'z', 'w', 'Last line.'));

    // Its place: the line now where it was, not "Last line." four lines down.
    expect(editor.state.selection.$head.parent.textContent).toBe('x');
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

describe('the re-read mapping is linear in the note (#885)', () => {
  /**
   * How many times carrying a caret across a re-read compares or reads a
   * node, on a note of `lines` lines, many identical, with every other line
   * changed: the changed stretch is the whole note, so the scans over it run
   * in full, the caret's line among them (on the middle line, kept, with some
   * of its twins changed). Counted, not timed: the times are in #886.
   */
  function comparisons(lines: number, schema: Schema): number {
    const content = Array.from({ length: lines }, (_, i) =>
      paragraph(i % 3 === 0 ? '' : 'Same line.'),
    );
    const middle = 2 * Math.floor(lines / 4);
    const changed = content.map((block, i) => (i % 2 === 1 ? paragraph(`Changed ${i}.`) : block));
    const before = schema.nodeFromJSON(docOf(content));
    const after = schema.nodeFromJSON(docOf(changed));
    let caret = 0;
    before.forEach((_node, offset, i) => {
      if (i === middle) caret = offset + 1;
    });
    const spies = [
      vi.spyOn(ProseMirrorNode.prototype, 'eq'),
      vi.spyOn(ProseMirrorNode.prototype, 'toJSON'),
      vi.spyOn(ProseMirrorNode.prototype, 'textContent', 'get'),
      vi.spyOn(Fragment.prototype, 'findDiffStart'),
      vi.spyOn(Fragment.prototype, 'findDiffEnd'),
    ];
    try {
      selectionAfterReread(TextSelection.create(before, caret), { before, after });
      return spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  }

  it('makes about five times the comparisons for five times the lines, not twenty-five', () => {
    const schema = getSchema(extensions());
    const small = comparisons(1000, schema);
    const large = comparisons(5000, schema);

    expect(small).toBeGreaterThan(0);
    expect(large / small).toBeGreaterThan(4);
    expect(large / small).toBeLessThan(7);
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
