// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { undo } from '@tiptap/pm/history';
import type {
  EditorDocument,
  EditorNode,
  NoteSuggestion,
  OutlineEntry,
  Transclusion,
  VaultPath,
  WikiLink,
} from '@dfai/domain';
import { NoteEditor, type NoteTransclusions } from './note-editor.tsx';
import type { BlockPicking } from './editor/block-picking.ts';

/**
 * Blocks in a note (P26-01..03): `![[` picks a note, `#` its headings and
 * blocks; the block picked is linked by its id — given one, in its own note
 * or in this one, where it has none — and shown live as a block of its own,
 * or said to be missing.
 */

afterEach(cleanup);

beforeAll(() => {
  const empty = () => DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = empty;
  Element.prototype.scrollIntoView = () => {};
  // jsdom has no ClipboardEvent; `pasteHTML` only makes one to hand to paste handlers.
  if (typeof globalThis.ClipboardEvent === 'undefined') {
    globalThis.ClipboardEvent = class extends Event {
      readonly clipboardData = null;
    } as unknown as typeof ClipboardEvent;
  }
});

const text = (value: string): EditorNode => ({ type: 'text', text: value });
const paragraph = (value: string, anchor?: string): EditorNode => ({
  type: 'paragraph',
  ...(anchor !== undefined && { attrs: { anchor } }),
  ...(value === '' ? {} : { content: [text(value)] }),
});
const doc = (...content: EditorNode[]): EditorDocument => ({ type: 'doc', content });

const PLANS: NoteSuggestion = { path: 'Plans.md' as VaultPath, target: 'Plans' };
const ENTRIES: OutlineEntry[] = [
  { kind: 'heading', text: 'Plans', level: 1, at: [0] },
  { kind: 'block', text: 'Pack the tent', id: 't1', type: 'listItem', at: [1, 0] },
  { kind: 'block', text: 'Book the train', id: null, type: 'listItem', at: [1, 1] },
];

function picking(overrides: Partial<BlockPicking> = {}): BlockPicking {
  return {
    choicesFor: async (target) =>
      target === 'Plans'
        ? { same: false, target, path: 'Plans.md' as VaultPath, entries: ENTRIES }
        : target === ''
          ? { same: true, target }
          : null,
    anchor: async () => 'n3w1d2',
    newId: () => 'own123',
    onRefused: () => {},
    ...overrides,
  };
}

const PACK: Transclusion = {
  kind: 'block',
  path: 'Plans.md' as VaultPath,
  title: 'Summer plans',
  archived: false,
  fragment: { kind: 'block', id: 't1' },
  content: doc(paragraph('Pack the tent')),
  highlight: null,
  highlightView: null,
};

async function editorIn(container: HTMLElement): Promise<Editor> {
  const element = await waitFor(() => {
    const found = container.querySelector('.ProseMirror');
    if (found === null) throw new Error('no editor yet');
    return found;
  });
  return (element as HTMLElement & { editor: Editor }).editor;
}

function renderEditor(
  initial: EditorDocument,
  {
    blocks = picking(),
    transclusions = { load: async () => PACK, loadImage: async () => null, revision: 0 },
  }: { blocks?: BlockPicking; transclusions?: NoteTransclusions } = {},
) {
  const onChange = vi.fn<(changed: EditorDocument) => void>();
  const onFollowLink = vi.fn<(target: string, heading?: string | null) => void>();
  const view = (current: NoteTransclusions) => (
    <NoteEditor
      doc={initial}
      onChange={onChange}
      onFollowLink={onFollowLink}
      suggestNotes={() => [PLANS]}
      loadImage={async () => null}
      picking={blocks}
      transclusions={current}
    />
  );
  const rendered = render(view(transclusions));
  return {
    ...rendered,
    onChange,
    onFollowLink,
    lastDoc: () => onChange.mock.lastCall?.[0],
    rerenderWith: (next: NoteTransclusions) => rendered.rerender(view(next)),
  };
}

function typeInto(editor: Editor, typed: string) {
  act(() => {
    editor.commands.focus('end');
    for (const char of typed) {
      const { from, to } = editor.state.selection;
      editor.view.dispatch(editor.state.tr.insertText(char, from, to));
    }
  });
}

function press(editor: Editor, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true });
  return editor.view.someProp('handleKeyDown', (handle) => handle(editor.view, event)) === true;
}

/** The top-level blocks, as their type and what they hold. */
const shape = (changed: EditorDocument | undefined) =>
  changed?.content.map((node) =>
    node.type === 'blockEmbed'
      ? `embed:${String(node.attrs?.['target'])}${String(node.attrs?.['heading'])}`
      : `${node.type}:${(node.content ?? [])
          .map((child) =>
            child.type === 'wikiLink'
              ? `${child.attrs?.['embed'] === true ? '!' : ''}[[${String(child.attrs?.['target'])}${String(child.attrs?.['heading'] ?? '')}]]`
              : (child.text ?? ''),
          )
          .join('')}`,
  );

describe('![[ then #: picking a note, then its block', () => {
  it('offers notes, then — once one is picked — its headings and blocks, each a line of what it says', async () => {
    const rendered = renderEditor(doc(paragraph('')));
    const editor = await editorIn(rendered.container);
    typeInto(editor, '![[Pl');
    await screen.findByRole('listbox', { name: 'Link to note' });
    act(() => {
      expect(press(editor, 'Enter')).toBe(true);
    });
    const blocks = await screen.findByRole('listbox', { name: 'Link to block' });
    const options = await waitFor(() => {
      const found = [...blocks.querySelectorAll('[role="option"]')].map(
        (option) => option.textContent,
      );
      if (found.length !== 3) throw new Error('not yet');
      return found;
    });
    expect(options).toEqual([
      'PlansHeading 1',
      'Pack the tentList item',
      'Book the trainList item',
    ]);
    expect(blocks.textContent).toContain('Embed');
  });

  it('offers nothing, rather than the last answer, once reading the note fails (#225, PR #612)', async () => {
    let reads = 0;
    const blocks = picking({
      choicesFor: async (target) => {
        reads += 1;
        if (reads > 1) throw new Error('the disk stopped answering');
        return { same: false, target, path: 'Plans.md' as VaultPath, entries: ENTRIES };
      },
    });
    const rendered = renderEditor(doc(paragraph('')), { blocks });
    const editor = await editorIn(rendered.container);
    typeInto(editor, '![[Plans#');
    const listbox = await screen.findByRole('listbox', { name: 'Link to block' });
    await waitFor(() => expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(3));

    typeInto(editor, 'P');

    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0));
  });

  it('shows a block that has an id, as a block of its own, where the line held only the embed', async () => {
    const rendered = renderEditor(doc(paragraph('')));
    const editor = await editorIn(rendered.container);
    typeInto(editor, '![[Plans#Pack');
    await screen.findByRole('option', { name: /Pack the tent/ });
    act(() => {
      expect(press(editor, 'Enter')).toBe(true);
    });
    await waitFor(() =>
      expect(shape(rendered.lastDoc())).toEqual(['embed:Plans#^t1', 'paragraph:']),
    );
    const shown = await screen.findByRole('group', { name: 'Embedded block from Summer plans' });
    await waitFor(() => expect(shown.textContent).toContain('Pack the tent'));
  });

  it('gives a block of another note with no id one there first, then links it', async () => {
    const anchor = vi.fn<BlockPicking['anchor']>(async () => 'n3w1d2');
    const rendered = renderEditor(doc(paragraph('')), { blocks: picking({ anchor }) });
    const editor = await editorIn(rendered.container);
    typeInto(editor, '![[Plans#Book');
    await screen.findByRole('option', { name: /Book the train/ });
    act(() => {
      press(editor, 'Enter');
    });
    await waitFor(() =>
      expect(shape(rendered.lastDoc())).toEqual(['embed:Plans#^n3w1d2', 'paragraph:']),
    );
    expect(anchor).toHaveBeenCalledWith({ path: 'Plans.md', at: [1, 1], text: 'Book the train' });
  });

  it('links nothing, and says why, when that note refuses the id', async () => {
    const onRefused = vi.fn<(reason: string) => void>();
    const anchor = async () => {
      throw new Error('Plans has unsaved changes.');
    };
    const rendered = renderEditor(doc(paragraph('')), { blocks: picking({ anchor, onRefused }) });
    const editor = await editorIn(rendered.container);
    typeInto(editor, '![[Plans#Book');
    await screen.findByRole('option', { name: /Book the train/ });
    act(() => {
      press(editor, 'Enter');
    });
    await waitFor(() => expect(onRefused).toHaveBeenCalledWith('Plans has unsaved changes.'));
    expect(JSON.stringify(editor.getJSON())).not.toContain('blockEmbed');
    expect(editor.getText()).toContain('![[Plans#Book');
  });

  it('links a heading by its words, as a link after [[', async () => {
    const rendered = renderEditor(doc(paragraph('See ')));
    const editor = await editorIn(rendered.container);
    typeInto(editor, '[[Plans#Pla');
    await screen.findByRole('option', { name: /Heading 1/ });
    act(() => {
      press(editor, 'Enter');
    });
    await waitFor(() =>
      expect(shape(rendered.lastDoc())).toEqual(['paragraph:See [[Plans#Plans]] ']),
    );
  });

  it('gives a block of this note its id in the same step as the link, so one undo takes both', async () => {
    const own = doc(paragraph('Mine to show'), paragraph(''));
    const blocks = picking({
      choicesFor: async (target) => ({ same: true, target }),
    });
    const rendered = renderEditor(own, { blocks });
    const editor = await editorIn(rendered.container);
    typeInto(editor, '![[#Mine');
    await screen.findByRole('option', { name: /Mine to show/ });
    act(() => {
      press(editor, 'Enter');
    });
    await waitFor(() =>
      expect(shape(rendered.lastDoc())).toEqual([
        'paragraph:Mine to show',
        'embed:#^own123',
        'paragraph:',
      ]),
    );
    expect(rendered.lastDoc()?.content[0]?.attrs?.['anchor']).toBe('own123');
    act(() => {
      undo(editor.state, editor.view.dispatch);
    });
    const back = editor.getJSON() as EditorDocument;
    expect(back.content[0]?.attrs?.['anchor'] ?? null).toBeNull();
    expect(JSON.stringify(back)).not.toContain('blockEmbed');
  });
});

describe('linking a block, around the edges', () => {
  it('does not offer the line being typed in, among this note’s own blocks', async () => {
    const blocks = picking({ choicesFor: async (target) => ({ same: true, target }) });
    const rendered = renderEditor(doc(paragraph('A block with a q'), paragraph('')), { blocks });
    const editor = await editorIn(rendered.container);
    typeInto(editor, '![[#q');
    const listbox = await screen.findByRole('listbox', { name: 'Link to block' });
    await waitFor(() => expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(1));
    expect(listbox.textContent).toContain('A block with a q');
    expect(listbox.textContent).not.toContain('![[#q');
  });

  it('keeps what is typed after the link while the other note is written', async () => {
    let finish: (id: string) => void = () => {};
    const anchor = () => new Promise<string>((resolve) => (finish = resolve));
    const rendered = renderEditor(doc(paragraph('')), { blocks: picking({ anchor }) });
    const editor = await editorIn(rendered.container);
    typeInto(editor, '![[Plans#Book');
    await screen.findByRole('option', { name: /Book the train/ });
    act(() => {
      press(editor, 'Enter');
    });
    typeInto(editor, ' more');
    await act(async () => {
      finish('n3w1d2');
      await Promise.resolve();
    });
    await waitFor(() => expect(JSON.stringify(editor.getJSON())).toContain('#^n3w1d2'));
    expect(editor.getText()).toContain('more');
  });
});

describe('opening a note at a block', () => {
  it('marks the block for a moment, once, and says it was shown', async () => {
    const done = vi.fn();
    const onChange = vi.fn();
    const view = render(
      <NoteEditor
        doc={doc(paragraph('Before'), paragraph('The one', 't1'))}
        onChange={onChange}
        onFollowLink={() => {}}
        suggestNotes={() => []}
        loadImage={async () => null}
        reveal={{ fragment: { kind: 'block', id: 't1' }, key: 1, done }}
      />,
    );
    await waitFor(() =>
      expect(view.container.querySelector('.is-revealed')?.textContent).toBe('The one'),
    );
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe('a shown block', () => {
  const shownDoc = doc({
    type: 'blockEmbed',
    attrs: { target: 'Plans', heading: '#^t1', alias: null },
  });

  it('is read by its link, and drawn with the name of the note it is in', async () => {
    const load = vi.fn<(link: WikiLink) => Promise<Transclusion>>(async () => PACK);
    renderEditor(shownDoc, { transclusions: { load, loadImage: async () => null, revision: 0 } });
    const shown = await screen.findByRole('group', { name: 'Embedded block from Summer plans' });
    await waitFor(() => expect(shown.textContent).toContain('Pack the tent'));
    expect(load).toHaveBeenCalledWith({ target: 'Plans', heading: '#^t1', alias: null });
  });

  it('is read again when the page says notes have changed', async () => {
    let words = 'Pack the tent';
    const load = async (): Promise<Transclusion> => ({ ...PACK, content: doc(paragraph(words)) });
    const rendered = renderEditor(shownDoc, {
      transclusions: { load, loadImage: async () => null, revision: 0 },
    });
    const shown = await screen.findByRole('group', { name: 'Embedded block from Summer plans' });
    await waitFor(() => expect(shown.textContent).toContain('Pack the tent'));
    words = 'Pack the big tent';
    rendered.rerenderWith({ load, loadImage: async () => null, revision: 1 });
    await waitFor(() => expect(shown.textContent).toContain('Pack the big tent'));
  });

  it('says when its block, or its note, is missing, and when its note is archived', async () => {
    const states: Transclusion[] = [
      {
        kind: 'missing-block',
        path: 'Plans.md' as VaultPath,
        title: 'Plans',
        archived: false,
        fragment: { kind: 'block', id: 't1' },
      },
      { kind: 'missing-note', label: 'Gone' },
      { ...PACK, archived: true },
    ];
    for (const state of states) {
      cleanup();
      renderEditor(shownDoc, {
        transclusions: { load: async () => state, loadImage: async () => null, revision: 0 },
      });
      const shown = await screen.findByRole('group', { name: /^Embedded block from/ });
      await waitFor(() => expect(shown.textContent).not.toContain('Loading'));
      if (state.kind === 'missing-block')
        expect(shown.textContent).toContain('“Plans” has no block ^t1');
      if (state.kind === 'missing-note')
        expect(shown.textContent).toContain('No note is called “Gone”');
      if (state.kind === 'block') expect(shown.textContent).toContain('Archived');
      expect(shown.className.includes('block-embed--broken')).toBe(state.kind !== 'block');
    }
  });

  it('opens its note at the block when its note’s name is clicked', async () => {
    const rendered = renderEditor(shownDoc);
    const name = await screen.findByRole('link', { name: 'Summer plans' });
    act(() => {
      name.click();
    });
    expect(rendered.onFollowLink).toHaveBeenCalledWith('Plans', '#^t1', 'here');
  });
});

describe('a block id in the editor', () => {
  it('stays with the first half when its block is split by Enter', async () => {
    const rendered = renderEditor(doc(paragraph('Keep this', 'a1')));
    const editor = await editorIn(rendered.container);
    act(() => {
      editor.commands.setTextSelection(5);
      editor.commands.splitBlock();
    });
    const [first, second] = (editor.getJSON() as EditorDocument).content;
    expect(first?.attrs?.['anchor']).toBe('a1');
    expect(second?.attrs?.['anchor'] ?? null).toBeNull();
  });

  it('is taken off a pasted copy of a block whose id the note still has, even pasted above it', async () => {
    const rendered = renderEditor(doc(paragraph(''), paragraph('Original', 'a1')));
    const editor = await editorIn(rendered.container);
    act(() => {
      editor.commands.focus('start');
      editor.view.pasteHTML(
        '<p>Lead</p><p data-block-anchor="a1">Copy</p><p data-block-anchor="b2">New</p><p>Tail</p>',
      );
    });
    const ids = Object.fromEntries(
      (editor.getJSON() as EditorDocument).content.map((node) => [
        (node.content ?? []).map((child) => child.text).join(''),
        node.attrs?.['anchor'] ?? null,
      ]),
    );
    expect(ids).toMatchObject({ Original: 'a1', Copy: null, New: 'b2' });
  });

  it('stays with its words when Enter is pressed at the start of its block', async () => {
    const list: EditorNode = {
      type: 'bulletList',
      content: [{ type: 'listItem', attrs: { anchor: 'i1' }, content: [paragraph('Item')] }],
    };
    const rendered = renderEditor(doc(paragraph('Keep this', 'a1'), list));
    const editor = await editorIn(rendered.container);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.splitBlock();
    });
    const [empty, kept] = (editor.getJSON() as EditorDocument).content;
    expect(empty?.attrs?.['anchor'] ?? null).toBeNull();
    expect(kept?.attrs?.['anchor']).toBe('a1');
    expect(kept?.content?.[0]?.text).toBe('Keep this');
    act(() => {
      // Into the item's words, then Enter at their start.
      let at = 0;
      editor.state.doc.descendants((node, position) => {
        if (node.isText && node.text === 'Item') at = position;
      });
      editor.commands.setTextSelection(at);
      editor.commands.splitListItem('listItem');
    });
    const items = (editor.getJSON() as EditorDocument).content[2]?.content ?? [];
    expect(
      items.map((item) => [
        item.attrs?.['anchor'] ?? null,
        item.content?.[0]?.content?.[0]?.text ?? '',
      ]),
    ).toEqual([
      [null, ''],
      ['i1', 'Item'],
    ]);
  });

  it('stays with its words when Backspace joins its block to the one above', async () => {
    const rendered = renderEditor(doc(paragraph('First'), paragraph('Second', 'b2')));
    const editor = await editorIn(rendered.container);
    act(() => {
      editor.commands.setTextSelection(8);
      editor.commands.joinBackward();
    });
    const [joined] = (editor.getJSON() as EditorDocument).content;
    expect(joined?.content?.[0]?.text).toBe('FirstSecond');
    expect(joined?.attrs?.['anchor']).toBe('b2');
  });

  it('is not given to a block when it is deleted with its words', async () => {
    const rendered = renderEditor(doc(paragraph('Keep'), paragraph('Gone', 'g1')));
    const editor = await editorIn(rendered.container);
    act(() => {
      editor.commands.deleteRange({ from: 6, to: editor.state.doc.content.size });
    });
    expect(JSON.stringify(editor.getJSON())).not.toContain('g1');
  });

  it('is held by one block only, whatever makes two', async () => {
    const rendered = renderEditor(doc(paragraph('One', 'a1'), paragraph('Two')));
    const editor = await editorIn(rendered.container);
    act(() => {
      editor.view.dispatch(editor.state.tr.setNodeAttribute(5, 'anchor', 'a1'));
    });
    const anchors = (editor.getJSON() as EditorDocument).content.map(
      (node) => node.attrs?.['anchor'] ?? null,
    );
    expect(anchors).toEqual(['a1', null]);
  });
});
