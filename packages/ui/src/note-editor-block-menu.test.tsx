// @vitest-environment jsdom
/**
 * A block's menu in a note (#569): ⌘/ with the caret in a block opens it,
 * hung from the block's handle; its rows do what they say to that block,
 * one that would do nothing is disabled, and the caret goes back to the note.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import type { EditorDocument, EditorNode } from '@dfai/domain';
import { NoteEditor } from './note-editor.tsx';

afterEach(cleanup);

beforeAll(() => {
  const empty = () => DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = empty;
  Element.prototype.scrollIntoView = () => {};
});

const paragraph = (value: string): EditorNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text: value }],
});
const doc = (...content: EditorNode[]): EditorDocument => ({ type: 'doc', content });

async function renderNote(initial: EditorDocument) {
  const onChange = vi.fn<(changed: EditorDocument) => void>();
  const rendered = render(
    <NoteEditor
      doc={initial}
      onChange={onChange}
      onFollowLink={() => {}}
      suggestNotes={() => []}
      loadImage={async () => null}
    />,
  );
  const element = await waitFor(() => {
    const found = rendered.container.querySelector('.ProseMirror');
    if (found === null) throw new Error('no editor yet');
    return found;
  });
  const editor = (element as HTMLElement & { editor: Editor }).editor;
  return { ...rendered, editor, onChange };
}

/** The words of each block of the note, in order. */
const words = (editor: Editor): string[] => {
  const all: string[] = [];
  editor.state.doc.forEach((node) => all.push(node.textContent));
  return all;
};

/** ⌘/ (Ctrl+/ off a Mac) with the caret at the start of the block reading `text`. */
function openMenuIn(editor: Editor, text: string) {
  let at = -1;
  editor.state.doc.forEach((node, pos) => {
    if (node.textContent === text) at = pos + 1;
  });
  const mac = /Mac/.test(navigator.platform);
  act(() => {
    editor.commands.setTextSelection(at);
    const event = new KeyboardEvent('keydown', {
      key: '/',
      bubbles: true,
      metaKey: mac,
      ctrlKey: !mac,
    });
    editor.view.someProp('handleKeyDown', (handle) => handle(editor.view, event));
  });
}

describe("a block's menu", () => {
  it('opens on ⌘/ beside the block the caret is in, with every action and its keys', async () => {
    const { editor, container } = await renderNote(doc(paragraph('One.'), paragraph('Two.')));
    openMenuIn(editor, 'One.');
    const menu = await screen.findByRole('menu', { name: 'Block' });
    const rows = screen.getAllByRole('menuitem').map((row) => row.textContent);
    expect(rows).toEqual([
      'Add block above⌥⇧↩',
      'Add block below⌥↩',
      'Duplicate⌘D',
      'Move up⇧⌘↑',
      'Move down⇧⌘↓',
      'Delete⇧⌘⌫',
    ]);
    expect(menu).toBeTruthy();
    const handle = container.querySelector('[data-block-handle]');
    expect(handle).not.toBeNull();
    expect((handle as HTMLElement).hidden).toBe(false);
  });

  it('disables Move up on the first block', async () => {
    const { editor } = await renderNote(doc(paragraph('One.'), paragraph('Two.')));
    openMenuIn(editor, 'One.');
    const moveUp = await screen.findByRole('menuitem', { name: /Move up/ });
    expect(moveUp.getAttribute('aria-disabled')).toBe('true');
    expect(
      screen.getByRole('menuitem', { name: /Move down/ }).getAttribute('aria-disabled'),
    ).not.toBe('true');
  });

  it('duplicates the block from its row, closes, and puts the caret back in the note', async () => {
    const { editor } = await renderNote(doc(paragraph('One.'), paragraph('Two.')));
    openMenuIn(editor, 'Two.');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Duplicate/ }));
    expect(words(editor)).toEqual(['One.', 'Two.', 'Two.']);
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Block' })).toBeNull());
    expect(editor.state.selection.$head.parent.textContent).toBe('Two.');
  });

  it('moves the block down from its row', async () => {
    const { editor } = await renderNote(doc(paragraph('One.'), paragraph('Two.')));
    openMenuIn(editor, 'One.');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Move down/ }));
    expect(words(editor)).toEqual(['Two.', 'One.']);
  });
});
