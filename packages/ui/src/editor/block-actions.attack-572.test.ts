// @vitest-environment jsdom
/**
 * Attack on PR #572 (#569): the block handle's actions and drag over hostile
 * notes. A seeded property run applies random add / duplicate / move / delete
 * and undo to random notes holding every kind of block the editor draws, and
 * checks the note's invariants after each step; the rest are the cases the
 * run, or a read of the code, found. All data is fictional.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { BLOCK_ANCHOR_ATTR } from '@dfai/domain';
import { createEditorExtensions } from './extensions.ts';
import { BLOCK_ACTIONS, blockChange, blockTargetAt, type BlockTarget } from './block-actions.ts';
import type { HighlightBlocks } from './raw-block.ts';
import { HighlightDrafts } from './highlight-drafts.ts';

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

const highlightSource = (n: number) =>
  [
    `> Larkspur fern passage ${n}.`,
    `> <!-- atlas:highlight {"v":1,"mark":"highlight","color":"yellow","kind":"pdf","page":${n}} -->`,
    '>',
    `> Comment ${n} for Mara Quill.`,
  ].join('\n');
const tombstoneSource = (n: number) =>
  `<!-- atlas:highlight-removed {"v":1,"kind":"kindle","location":${n},"annotationId":"A${n}","words":"w${n}"} -->`;

const text = (words: string): JSONContent => ({ type: 'text', text: words });
const paragraph = (words: string, anchor: string | null = null): JSONContent => ({
  type: 'paragraph',
  attrs: { [BLOCK_ANCHOR_ATTR]: anchor },
  content: [text(words)],
});
const raw = (markdown: string, anchor: string | null = null): JSONContent => ({
  type: 'rawBlock',
  attrs: { markdown, [BLOCK_ANCHOR_ATTR]: anchor },
});
const item = (...content: JSONContent[]): JSONContent => ({ type: 'listItem', content });
const bullets = (...items: JSONContent[]): JSONContent => ({ type: 'bulletList', content: items });
const cell = (...content: JSONContent[]): JSONContent => ({ type: 'tableCell', content });
const row = (...cells: JSONContent[]): JSONContent => ({ type: 'tableRow', content: cells });

const isHighlightNode = (node: ProseMirrorNode) =>
  node.type.name === 'rawBlock' && String(node.attrs['markdown']).includes('atlas:highlight {');
const isTombstoneNode = (node: ProseMirrorNode) =>
  node.type.name === 'rawBlock' && String(node.attrs['markdown']).includes('highlight-removed');

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function noteOf(content: JSONContent[], highlights: HighlightBlocks | null = null): Editor {
  editor?.destroy();
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
      highlights,
    }),
    content: { type: 'doc', content },
  });
  return editor;
}

/** A literature note's highlights, each quote holding a marker one, with a recorded write. */
const highlightsWith = (remove: (id: string) => void): HighlightBlocks => ({
  viewOf: ({ markdown, id }) =>
    markdown.includes('atlas:highlight {')
      ? { id, mark: 'highlight', color: 'yellow', words: 'Ferns', comment: '', picture: null }
      : null,
  editComment: async () => {},
  drafts: new HighlightDrafts(),
  loadImage: async () => null,
  remove,
});

/** A key as the person presses it, through the editor's keymaps. */
function press(instance: Editor, key: string): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  return instance.view.someProp('handleKeyDown', (handle) => handle(instance.view, event)) ?? false;
}

/** Drags `selection` as the handle starts its drag, and drops it at `pos`, as ProseMirror drops it. */
function dragTo(instance: Editor, selection: NodeSelection, pos: number): void {
  const { view } = instance;
  view.dispatch(instance.state.tr.setSelection(selection));
  view.posAtCoords = () => ({ pos, inside: -1 });
  (view as unknown as { dragging: unknown }).dragging = {
    slice: selection.content(),
    move: true,
    node: selection,
  };
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.assign(drop, {
    clientX: 0,
    clientY: 0,
    altKey: false,
    ctrlKey: false,
    dataTransfer: { getData: () => '', types: [], files: [] },
  });
  view.dom.dispatchEvent(drop);
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

const topLevelIndexOf = (doc: ProseMirrorNode, predicate: (node: ProseMirrorNode) => boolean) => {
  let at = -1;
  doc.forEach((node, offset) => {
    if (at === -1 && predicate(node)) at = offset;
  });
  return at;
};

describe('Backspace or Delete on a selected highlight (decided: as the menu does)', () => {
  for (const key of ['Backspace', 'Delete']) {
    it(`${key} on a selected highlight writes its removal through the note, not an edit`, () => {
      const remove = vi.fn();
      const instance = noteOf(
        [paragraph('Before.'), raw(highlightSource(1), 'fern01'), paragraph('After.')],
        highlightsWith(remove),
      );
      const before = instance.state.doc;
      const at = topLevelIndexOf(before, isHighlightNode);
      instance.view.dispatch(
        instance.state.tr.setSelection(NodeSelection.create(instance.state.doc, at)),
      );
      press(instance, key);
      expect(remove).toHaveBeenCalledWith('fern01');
      expect(instance.state.doc.eq(before)).toBe(true);
    });
  }
});

describe('a block dragged by its handle', () => {
  it('into a table cell leaves every cell holding only the line a markdown cell can', () => {
    const instance = noteOf([
      bullets(item(paragraph('Water the ferns.')), item(paragraph('Repot.'))),
      {
        type: 'table',
        content: [
          row(cell(paragraph('Bed')), cell(paragraph('Plant'))),
          row(cell(paragraph('North')), cell(paragraph('Fern'))),
        ],
      },
    ]);
    const itemAt = textAt(instance, 'Water the ferns.') - 2;
    const intoCell = textAt(instance, 'North') + 'North'.length;
    dragTo(instance, NodeSelection.create(instance.state.doc, itemAt), intoCell);
    const cellContents: string[] = [];
    instance.state.doc.descendants((node) => {
      if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
        node.forEach((child) => cellContents.push(child.type.name));
      }
      return true;
    });
    // A cell is one line in markdown: a list or quote in it cannot be saved (the save throws).
    expect(cellContents.every((type) => type === 'paragraph')).toBe(true);
  });

  it('a highlight dropped into a list item stays a block of the note', () => {
    const instance = noteOf([
      bullets(item(paragraph('Water the ferns.'))),
      raw(highlightSource(1), 'fern01'),
      paragraph('After.'),
    ]);
    const highlightAt = topLevelIndexOf(instance.state.doc, isHighlightNode);
    const intoItem = textAt(instance, 'Water the ferns.') + 'Water the ferns.'.length;
    dragTo(instance, NodeSelection.create(instance.state.doc, highlightAt), intoItem);
    const nested: string[] = [];
    instance.state.doc.descendants((node, _pos, parent) => {
      if (isHighlightNode(node) && parent !== instance.state.doc)
        nested.push(parent?.type.name ?? '');
      return true;
    });
    // Read only at the top level (highlight-block.ts), a nested one is no highlight once saved.
    expect(nested).toEqual([]);
    expect(topLevelIndexOf(instance.state.doc, isHighlightNode)).toBeGreaterThanOrEqual(0);
  });

  it('a highlight dropped into a table cell stays a block of the note', () => {
    const instance = noteOf([
      raw(highlightSource(1), 'fern01'),
      { type: 'table', content: [row(cell(paragraph('North')), cell(paragraph('Fern')))] },
    ]);
    const intoCell = textAt(instance, 'North') + 'North'.length;
    dragTo(instance, NodeSelection.create(instance.state.doc, 0), intoCell);
    // A raw block in a cell is written as nothing: the save drops it silently.
    expect(topLevelIndexOf(instance.state.doc, isHighlightNode)).toBeGreaterThanOrEqual(0);
  });
});

describe('deleting the last block the person can see', () => {
  it('leaves the caret in a block they can type in, not on a hidden tombstone', () => {
    const instance = noteOf([raw(tombstoneSource(9)), paragraph('Only.')]);
    const target = blockTargetAt(instance.state.doc, {
      pos: textAt(instance, 'Only.'),
      inside: -1,
    });
    if (target === null) throw new Error('No block.');
    const change = blockChange(instance.state, {
      target,
      action: 'delete',
      isHighlight: isHighlightNode,
    });
    if (change === null || !('edit' in change)) throw new Error('No edit.');
    instance.view.dispatch(change.edit);
    expect(instance.state.selection.$head.parent.isTextblock).toBe(true);
  });
});

describe('one action is one undo step', () => {
  it('undo after Add block below and typing takes the typing back first', () => {
    const instance = noteOf([paragraph('One.'), paragraph('Two.')]);
    const target = blockTargetAt(instance.state.doc, { pos: 2, inside: -1 });
    if (target === null) throw new Error('No block.');
    const change = blockChange(instance.state, {
      target,
      action: 'addBelow',
      isHighlight: isHighlightNode,
    });
    if (change === null || !('edit' in change)) throw new Error('No edit.');
    instance.view.dispatch(change.edit);
    const added = instance.state.doc;
    instance.commands.insertContent('Typed.');
    instance.commands.undo();
    expect(instance.state.doc.eq(added)).toBe(true);
  });
});

/** A key with modifiers as the person presses it: Mod is ⌘ on a Mac, Ctrl elsewhere, as Tiptap reads it. */
function pressWith(
  instance: Editor,
  key: string,
  { mod = false, shift = false }: { mod?: boolean; shift?: boolean },
): boolean {
  const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    metaKey: mod && mac,
    ctrlKey: mod && !mac,
    shiftKey: shift,
  });
  return instance.view.someProp('handleKeyDown', (handle) => handle(instance.view, event)) ?? false;
}

/** Runs `action` on the block reading `words`, as its menu does. */
function act(instance: Editor, words: string, action: (typeof BLOCK_ACTIONS)[number]): void {
  const target = blockTargetAt(instance.state.doc, { pos: textAt(instance, words), inside: -1 });
  if (target === null) throw new Error('No block.');
  const change = blockChange(instance.state, { target, action, isHighlight: isHighlightNode });
  if (change === null || !('edit' in change)) throw new Error(`No edit for ${action}.`);
  instance.view.dispatch(change.edit);
}

describe('move up then move down', () => {
  it('puts the note back as it was, the hidden tombstone where it was', () => {
    const instance = noteOf([paragraph('Fern.'), raw(tombstoneSource(9)), paragraph('Moss.')]);
    instance.view.dispatch(instance.state.tr.setMeta('addToHistory', false));
    const before = instance.state.doc;
    act(instance, 'Moss.', 'moveUp');
    act(instance, 'Moss.', 'moveDown');
    // Fern, tombstone, Moss → Moss, Fern, tombstone → Fern, Moss, tombstone: the file changed.
    expect(instance.state.doc.eq(before)).toBe(true);
  });
});

describe('⇧⌘↑ on the first block', () => {
  it('is not answered, so the platform’s own key (select to the start) still works', () => {
    const instance = noteOf([paragraph('First.'), paragraph('Second.')]);
    instance.commands.setTextSelection(textAt(instance, 'First.') + 3);
    const before = instance.state.doc;
    const handled = pressWith(instance, 'ArrowUp', { mod: true, shift: true });
    expect(instance.state.doc.eq(before)).toBe(true);
    expect(handled).toBe(false);
  });
});

describe('an ordered list item dragged out of its list', () => {
  it('stays a numbered item, not a bullet', () => {
    const instance = noteOf([
      {
        type: 'orderedList',
        attrs: { start: 1 },
        content: [item(paragraph('Sow.')), item(paragraph('Water.'))],
      },
      paragraph('After.'),
    ]);
    const itemAt = textAt(instance, 'Water.') - 2;
    const afterList = instance.state.doc.child(0).nodeSize;
    dragTo(instance, NodeSelection.create(instance.state.doc, itemAt), afterList);
    const $moved = instance.state.doc.resolve(textAt(instance, 'Water.'));
    // paragraph → listItem → its list.
    expect($moved.node($moved.depth - 2).type.name).toBe('orderedList');
  });
});

describe('a block dragged onto itself', () => {
  it('leaves the note unchanged', () => {
    const instance = noteOf([
      paragraph('Fern.'),
      paragraph('Moss grows slowly.'),
      paragraph('After.'),
    ]);
    instance.view.dispatch(instance.state.tr.setMeta('addToHistory', false));
    const before = instance.state.doc;
    const at = textAt(instance, 'Moss grows slowly.') - 1;
    dragTo(instance, NodeSelection.create(instance.state.doc, at), at + 5);
    expect(instance.state.doc.eq(before)).toBe(true);
  });

  it('the only block, dropped on itself, leaves the note unchanged', () => {
    const instance = noteOf([paragraph('Only.')]);
    instance.view.dispatch(instance.state.tr.setMeta('addToHistory', false));
    const before = instance.state.doc;
    dragTo(instance, NodeSelection.create(instance.state.doc, 0), 3);
    expect(instance.state.doc.eq(before)).toBe(true);
  });
});

describe('⌘D in a table cell', () => {
  it('duplicates the table whole, every ^id in the copy dropped', () => {
    const instance = noteOf([
      {
        type: 'table',
        content: [row(cell(paragraph('North', 'cel001')), cell(paragraph('Fern')))],
      },
    ]);
    instance.commands.setTextSelection(textAt(instance, 'North') + 1);
    pressWith(instance, 'd', { mod: true });
    const tables: number[] = [];
    instance.state.doc.forEach((node, _o, index) => {
      if (node.type.name === 'table') tables.push(index);
    });
    expect(tables).toHaveLength(2);
    expect(duplicatesOf(idsIn(instance.state.doc))).toEqual([]);
  });
});

/* ---- the property run ---- */

const SEED = Number(process.env['BLOCK_ACTIONS_SEED'] ?? 20261024);
const RUNS = Number(process.env['BLOCK_ACTIONS_RUNS'] ?? 120);
const STEPS = 12;

interface Generated {
  readonly content: JSONContent[];
}

function generatedNote(random: () => number): Generated {
  let serial = 0;
  const next = () => (serial += 1);
  const chance = (p: number) => random() < p;
  const anchor = () => (chance(0.3) ? `id${String(next()).padStart(4, '0')}` : null);
  const words = () => `Words ${next()} of Tobias Fenn`;
  const para = (): JSONContent => paragraph(words(), anchor());
  const listOf = (depth: number): JSONContent => {
    const type =
      depth === 0 && chance(0.3) ? 'taskList' : chance(0.3) ? 'orderedList' : 'bulletList';
    const itemType = type === 'taskList' ? 'taskItem' : 'listItem';
    const items = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
      type: itemType,
      ...(itemType === 'taskItem' && { attrs: { checked: chance(0.5) } }),
      content: [para(), ...(depth < 2 && chance(0.3) ? [listOf(depth + 1)] : [])],
    }));
    return { type, content: items };
  };
  const kinds: (() => JSONContent)[] = [
    para,
    () => ({ type: 'heading', attrs: { level: 2 }, content: [text(words())] }),
    () => listOf(0),
    () => ({ type: 'blockquote', content: [para(), ...(chance(0.5) ? [para()] : [])] }),
    () => ({ type: 'callout', attrs: { kind: 'note' }, content: [para()] }),
    () => ({
      type: 'table',
      content: [
        row(cell(paragraph(words())), cell(paragraph(words()))),
        row(cell(para()), cell(para())),
      ],
    }),
    () => ({
      type: 'paragraph',
      content: [
        text(`${words()}: `),
        { type: 'image', attrs: { src: `fern-${next()}.png`, alt: 'A fern' } },
      ],
    }),
    () => raw(`<div class="larkspur">${next()}</div>`, anchor()),
    () => {
      const n = next();
      return raw(highlightSource(n), `hl${String(n).padStart(4, '0')}`);
    },
    () => raw(tombstoneSource(next())),
    () => ({ type: 'codeBlock', attrs: { language: null }, content: [text(`code ${next()}`)] }),
  ];
  const content = Array.from({ length: 1 + Math.floor(random() * 8) }, () =>
    kinds[Math.floor(random() * kinds.length)]!(),
  );
  return { content };
}

/** Every place a handle sits: each list item, and each block of the note but a tombstone. */
function handleTargets(doc: ProseMirrorNode): BlockTarget[] {
  const targets: BlockTarget[] = [];
  doc.descendants((node, pos, parent) => {
    const isItem = node.type.name === 'listItem' || node.type.name === 'taskItem';
    if (isItem || (parent === doc && !isTombstoneNode(node))) targets.push({ pos, node });
    return !node.isTextblock && !node.isAtom;
  });
  return targets;
}

function idsIn(doc: ProseMirrorNode): string[] {
  const ids: string[] = [];
  doc.descendants((node) => {
    const id = node.attrs[BLOCK_ANCHOR_ATTR];
    if (typeof id === 'string') ids.push(id);
    return true;
  });
  return ids;
}

const highlightIdsIn = (doc: ProseMirrorNode): string[] => {
  const ids: string[] = [];
  doc.descendants((node) => {
    if (isHighlightNode(node)) ids.push(String(node.attrs[BLOCK_ANCHOR_ATTR]));
    return true;
  });
  return ids;
};

const tombstonesIn = (doc: ProseMirrorNode): string[] => {
  const found: string[] = [];
  doc.descendants((node) => {
    if (isTombstoneNode(node)) found.push(String(node.attrs['markdown']));
    return true;
  });
  return found.sort();
};

const duplicatesOf = (values: readonly string[]) =>
  values.filter((value, at) => values.indexOf(value) !== at);

/** Whether the person has somewhere to put the caret: a textblock in the note. */
function hasTextblock(doc: ProseMirrorNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (node.isTextblock) found = true;
    return !found;
  });
  return found;
}

/** The blocks of `before` the action did not touch, in order, are still in `after`, unchanged. */
function untouchedKept(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  touchedIndex: number,
): boolean {
  const kept: ProseMirrorNode[] = [];
  before.forEach((node, _offset, index) => {
    if (index !== touchedIndex) kept.push(node);
  });
  let at = 0;
  after.forEach((node) => {
    if (at < kept.length && node.eq(kept[at]!)) at += 1;
  });
  return at === kept.length;
}

describe('every handle action over generated notes', () => {
  it('keeps ids single, highlights single, tombstones exact, undo exact, untouched blocks unchanged', () => {
    const random = seeded(SEED);
    const failures: string[] = [];
    for (let run = 0; run < RUNS && failures.length < 8; run += 1) {
      const { content } = generatedNote(random);
      const instance = noteOf(content);
      // The editor's own fix-ups (a trailing paragraph after a table) land on the first
      // transaction; let them land, unrecorded, so "before" is the note as the person sees it.
      instance.view.dispatch(instance.state.tr.setMeta('addToHistory', false));
      const tombstones = tombstonesIn(instance.state.doc);
      const highlightCount = highlightIdsIn(instance.state.doc).length;
      for (let step = 0; step < STEPS; step += 1) {
        const targets = handleTargets(instance.state.doc);
        if (targets.length === 0) break;
        const target = targets[Math.floor(random() * targets.length)]!;
        const action = BLOCK_ACTIONS[Math.floor(random() * BLOCK_ACTIONS.length)]!;
        const before = instance.state.doc;
        const change = blockChange(instance.state, {
          target,
          action,
          isHighlight: isHighlightNode,
        });
        if (change === null || !('edit' in change)) continue;
        instance.view.dispatch(change.edit);
        const after = instance.state.doc;
        const where = `seed ${SEED} run ${run} step ${step}: ${action} on ${target.node.type.name} at ${target.pos}`;
        const ids = idsIn(after);
        if (duplicatesOf(ids).length > 0) failures.push(`${where}: ^id twice ${duplicatesOf(ids)}`);
        const highlights = highlightIdsIn(after);
        if (duplicatesOf(highlights).length > 0) failures.push(`${where}: highlight twice`);
        if (highlights.length > highlightCount) failures.push(`${where}: a highlight was made`);
        if (JSON.stringify(tombstonesIn(after)) !== JSON.stringify(tombstones)) {
          failures.push(`${where}: tombstones changed`);
        }
        if (!hasTextblock(after)) failures.push(`${where}: no block left to type in`);
        const touched = before.resolve(target.pos).index(0);
        if (!untouchedKept(before, after, touched)) {
          failures.push(`${where}: a block it did not act on changed`);
        }
        if (random() < 0.4) {
          instance.commands.undo();
          if (!instance.state.doc.eq(before))
            failures.push(`${where}: undo is not the note before`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);
});

describe('closing many notes', () => {
  it('leaves no pointer listener of a handle on the page after 20 editors are destroyed', () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    try {
      const made = Array.from(
        { length: 20 },
        () =>
          new Editor({
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
            content: { type: 'doc', content: [paragraph('Fern.')] },
          }),
      );
      for (const each of made) each.destroy();
      const moves = (spy: typeof added) =>
        spy.mock.calls.filter(([type]) => type === 'mousemove').map(([, listener]) => listener);
      expect(moves(added).length).toBeGreaterThanOrEqual(20);
      expect(moves(added).filter((listener) => !moves(removed).includes(listener))).toEqual([]);
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }
  });
});
