// @vitest-environment jsdom
/**
 * Where a block dragged within its note lands (#569): the rules of
 * `plannedDrop`, and the drop as the editor makes it. Fictional data only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { createEditorExtensions } from './extensions.ts';
import { plannedDrop } from './block-drop.ts';

const HIGHLIGHT = [
  '> Ferns spread by spores.',
  '> <!-- atlas:highlight {"v":1,"mark":"highlight","color":"yellow","kind":"pdf","page":3} -->',
].join('\n');
const TOMBSTONE =
  '<!-- atlas:highlight-removed {"v":1,"kind":"kindle","location":9,"annotationId":"A9","words":"w9"} -->';

const text = (words: string): JSONContent => ({ type: 'text', text: words });
const paragraph = (words: string): JSONContent => ({ type: 'paragraph', content: [text(words)] });
const heading = (words: string): JSONContent => ({
  type: 'heading',
  attrs: { level: 2 },
  content: [text(words)],
});
const raw = (markdown: string, anchor: string | null = null): JSONContent => ({
  type: 'rawBlock',
  attrs: { markdown, anchor },
});
const item = (...content: JSONContent[]): JSONContent => ({ type: 'listItem', content });
const bullets = (...items: JSONContent[]): JSONContent => ({ type: 'bulletList', content: items });
const numbered = (...items: JSONContent[]): JSONContent => ({
  type: 'orderedList',
  attrs: { start: 1 },
  content: items,
});
const cell = (...content: JSONContent[]): JSONContent => ({ type: 'tableCell', content });
const row = (...cells: JSONContent[]): JSONContent => ({ type: 'tableRow', content: cells });
const table = (...rows: JSONContent[]): JSONContent => ({ type: 'table', content: rows });

let editor: Editor | null = null;
afterEach(() => editor?.destroy());

function noteOf(...content: JSONContent[]): Editor {
  editor = new Editor({
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
    content: { type: 'doc', content },
  });
  editor.view.dispatch(editor.state.tr);
  return editor;
}

/** Where the textblock reading `words` starts its text. */
function textAt(instance: Editor, words: string): number {
  let at = -1;
  instance.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isTextblock && node.textContent === words) at = pos + 1;
    return at === -1;
  });
  if (at === -1) throw new Error(`No block reads “${words}”.`);
  return at;
}

/** The top-level block satisfying `which`, selected whole. */
function blockSelection(
  instance: Editor,
  which: (node: ProseMirrorNode) => boolean,
): NodeSelection {
  let at = -1;
  instance.state.doc.forEach((node, offset) => {
    if (at === -1 && which(node)) at = offset;
  });
  if (at === -1) throw new Error('No such block.');
  return NodeSelection.create(instance.state.doc, at);
}

const isRaw = (markdown: string) => (node: ProseMirrorNode) =>
  node.type.name === 'rawBlock' && node.attrs['markdown'] === markdown;

/** The outline of the note: each block's type, its children's in brackets. */
function outline(node: ProseMirrorNode): string {
  if (node.isTextblock || node.isAtom)
    return `${node.type.name}${node.isTextblock ? `(${node.textContent})` : ''}`;
  const children: string[] = [];
  node.forEach((child) => children.push(outline(child)));
  return `${node.type.name}[${children.join(' ')}]`;
}
const outlines = (instance: Editor): string[] => {
  const out: string[] = [];
  instance.state.doc.forEach((node) => out.push(outline(node)));
  return out;
};

/** Drops `selection`, dragged as the handle drags it, at `pos`, moved or copied with the key. */
function dragTo(
  instance: Editor,
  selection: NodeSelection,
  pos: number,
  { copy = false }: { copy?: boolean } = {},
): void {
  const { view } = instance;
  view.dispatch(instance.state.tr.setSelection(selection));
  view.posAtCoords = () => ({ pos, inside: -1 });
  (view as unknown as { dragging: unknown }).dragging = {
    slice: selection.content(),
    move: !copy,
    node: selection,
  };
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.assign(drop, {
    clientX: 0,
    clientY: 0,
    // The copy key is Alt on a Mac, Ctrl elsewhere: jsdom is "elsewhere", so both are held.
    altKey: copy,
    ctrlKey: copy,
    dataTransfer: { getData: () => '', types: [], files: [] },
  });
  view.dom.dispatchEvent(drop);
}

describe('a drop into a table cell', () => {
  const note = () =>
    noteOf(
      paragraph('Water the ferns.'),
      heading('Beds'),
      table(row(cell(paragraph('North')), cell(paragraph('Fern')))),
    );

  it('takes a paragraph: the cell is a line of text, and the paragraph joins it', () => {
    const instance = note();
    const intoCell = textAt(instance, 'North') + 'North'.length;
    dragTo(
      instance,
      blockSelection(instance, (node) => node.textContent === 'Water the ferns.'),
      intoCell,
    );
    expect(outlines(instance)).toEqual([
      'heading(Beds)',
      'table[tableRow[tableCell[paragraph(North) paragraph(Water the ferns.)] tableCell[paragraph(Fern)]]]',
      'paragraph()',
    ]);
  });

  it('refuses a heading, and the note is as it was', () => {
    const instance = note();
    const before = instance.state.doc;
    const intoCell = textAt(instance, 'North') + 'North'.length;
    dragTo(
      instance,
      blockSelection(instance, (node) => node.type.name === 'heading'),
      intoCell,
    );
    expect(instance.state.doc.eq(before)).toBe(true);
  });

  it('refuses a table dropped into a cell of another', () => {
    const instance = noteOf(
      table(row(cell(paragraph('North')))),
      table(row(cell(paragraph('South')))),
    );
    const before = instance.state.doc;
    const intoCell = textAt(instance, 'North') + 'North'.length;
    dragTo(
      instance,
      blockSelection(instance, (node) => node.textContent === 'South'),
      intoCell,
    );
    expect(instance.state.doc.eq(before)).toBe(true);
  });
});

describe('a raw block dropped into a container', () => {
  it('lands at the top level after the list, where it was dropped in the list’s last item', () => {
    const instance = noteOf(
      raw(HIGHLIGHT, 'fern01'),
      bullets(item(paragraph('Water.')), item(paragraph('Repot.'))),
      paragraph('After.'),
    );
    const intoItem = textAt(instance, 'Repot.') + 'Repot.'.length;
    dragTo(instance, blockSelection(instance, isRaw(HIGHLIGHT)), intoItem);
    expect(outlines(instance)).toEqual([
      'bulletList[listItem[paragraph(Water.)] listItem[paragraph(Repot.)]]',
      'rawBlock',
      'paragraph(After.)',
    ]);
    expect(instance.state.doc.child(1).attrs['anchor']).toBe('fern01');
  });

  it('lands before the quote it was dropped at the start of', () => {
    const instance = noteOf(
      paragraph('Before.'),
      { type: 'blockquote', content: [paragraph('Quoted words here.')] },
      raw('<div class="larkspur">Raw</div>'),
    );
    const intoQuote = textAt(instance, 'Quoted words here.');
    dragTo(instance, blockSelection(instance, isRaw('<div class="larkspur">Raw</div>')), intoQuote);
    expect(outlines(instance).slice(0, 3)).toEqual([
      'paragraph(Before.)',
      'rawBlock',
      'blockquote[paragraph(Quoted words here.)]',
    ]);
  });
});

describe('a list item dragged out of its list', () => {
  it('from a numbered list to the top level is still numbered', () => {
    const instance = noteOf(
      numbered(item(paragraph('Sow.')), item(paragraph('Water.'))),
      paragraph('After.'),
    );
    const itemAt = textAt(instance, 'Water.') - 2;
    dragTo(
      instance,
      NodeSelection.create(instance.state.doc, itemAt),
      instance.state.doc.content.size,
    );
    expect(outlines(instance)).toEqual([
      'orderedList[listItem[paragraph(Sow.)]]',
      'paragraph(After.)',
      'orderedList[listItem[paragraph(Water.)]]',
      'paragraph()',
    ]);
  });

  it('into another list joins that list as one of its items', () => {
    const instance = noteOf(
      numbered(item(paragraph('Sow.')), item(paragraph('Water.'))),
      bullets(item(paragraph('Moss.'))),
    );
    const itemAt = textAt(instance, 'Water.') - 2;
    const afterMoss = textAt(instance, 'Moss.') + 'Moss.'.length + 2;
    dragTo(instance, NodeSelection.create(instance.state.doc, itemAt), afterMoss);
    expect(outlines(instance)).toEqual([
      'orderedList[listItem[paragraph(Sow.)]]',
      'bulletList[listItem[paragraph(Moss.)] listItem[paragraph(Water.)]]',
      'paragraph()',
    ]);
  });
});

describe('a block dropped on itself', () => {
  it('moved, leaves the note as it was, the only block too', () => {
    const instance = noteOf(paragraph('Only.'));
    const before = instance.state.doc;
    dragTo(instance, NodeSelection.create(instance.state.doc, 0), 3);
    expect(instance.state.doc.eq(before)).toBe(true);
  });

  it('copied with the key, is duplicated beside itself', () => {
    const instance = noteOf(paragraph('Only.'));
    dragTo(instance, NodeSelection.create(instance.state.doc, 0), 3, { copy: true });
    expect(outlines(instance)).toEqual(['paragraph(Only.)', 'paragraph(Only.)']);
  });
});

describe('the plan of a drop', () => {
  it('is null for a copy that would put in nothing: a tombstone alone', () => {
    const instance = noteOf(paragraph('A.'), raw(TOMBSTONE), paragraph('B.'));
    const selection = blockSelection(instance, isRaw(TOMBSTONE));
    const planned = plannedDrop(instance.state.doc, {
      pos: instance.state.doc.content.size,
      slice: selection.content(),
      dragged: selection,
      moved: false,
    });
    expect(planned).toBeNull();
  });

  it('copies a highlight as a plain quote, its marker and id gone (PR #534)', () => {
    const instance = noteOf(raw(HIGHLIGHT, 'fern01'), paragraph('After.'));
    const selection = blockSelection(instance, isRaw(HIGHLIGHT));
    const planned = plannedDrop(instance.state.doc, {
      pos: instance.state.doc.content.size,
      slice: selection.content(),
      dragged: selection,
      moved: false,
    });
    const copy = planned?.slice.content.firstChild;
    expect(String(copy?.attrs['markdown'])).not.toContain('atlas:highlight');
    expect(copy?.attrs['anchor']).toBeNull();
  });
});

describe('a drop that did not begin in the note', () => {
  it('is left to the editor, which puts the text where it was dropped', () => {
    const instance = noteOf(paragraph('Fern.'), paragraph('Moss.'));
    const { view } = instance;
    view.posAtCoords = () => ({ pos: textAt(instance, 'Moss.'), inside: -1 });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.assign(drop, {
      clientX: 0,
      clientY: 0,
      altKey: false,
      ctrlKey: false,
      dataTransfer: {
        getData: (type: string) => (type === 'text/html' ? '' : 'From elsewhere. '),
        types: ['text/plain'],
        files: [],
      },
    });
    view.dom.dispatchEvent(drop);
    expect(outlines(instance)).toEqual(['paragraph(Fern.)', 'paragraph(From elsewhere. Moss.)']);
  });
});
