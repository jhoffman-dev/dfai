// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorDocument } from '@dfai/domain';
import { BlockAnchor, showAsRead } from './block-anchor.ts';

/*
 * #877: a note re-read from its file is shown in place of what the editor
 * holds. The caret stays where it was in the text, never jumping to the
 * note's end, and the next caret the page reports is read even when it is
 * on the spot the editor last read before the re-read.
 */

let editor: Editor;

const paragraph = (text: string) => ({
  type: 'paragraph',
  ...(text === '' ? {} : { content: [{ type: 'text', text }] }),
});
const note = (...lines: string[]): EditorDocument =>
  ({ type: 'doc', content: lines.map(paragraph) }) as unknown as EditorDocument;

const LINE_1 = 'Line 1 of the plan.';
const LINE_2 = 'Line 2 of the plan.';
const LINE_3 = 'Line 3 of the plan.';

beforeEach(() => {
  editor = new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: [StarterKit, BlockAnchor],
    content: note(LINE_1, LINE_2, LINE_3) as object,
    // jsdom focuses only an element with a tabindex; a browser focuses contenteditable as is.
    editorProps: { attributes: { tabindex: '-1' } },
  });
});

afterEach(() => {
  editor.destroy();
  document.body.replaceChildren();
});

/** The position `offset` characters into the paragraph holding `text` (its first). */
function at(text: string, offset: number): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found === -1 && node.isTextblock && node.textContent === text) found = pos + 1 + offset;
    return found === -1;
  });
  if (found === -1) throw new Error(`No paragraph reads "${text}".`);
  return found;
}

function select(anchor: number, head = anchor): void {
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head)),
  );
}

describe('showAsRead keeps the caret in its place (#877)', () => {
  it('keeps it on the same line and offset when other lines change', () => {
    select(at(LINE_2, LINE_2.length));
    showAsRead(editor, note(LINE_1, LINE_2, LINE_3, 'Theirs, added outside.'));

    expect(editor.state.selection.head).toBe(at(LINE_2, LINE_2.length));
  });

  it('keeps it on its line when a line is added before it', () => {
    select(at(LINE_2, 4));
    showAsRead(editor, note('Theirs, on top.', LINE_1, LINE_2, LINE_3));

    expect(editor.state.selection.head).toBe(at(LINE_2, 4));
  });

  it('puts it at the end of the line before when its line is removed', () => {
    select(at(LINE_2, 4));
    showAsRead(editor, note(LINE_1, LINE_3));

    expect(editor.state.selection.head).toBe(at(LINE_1, LINE_1.length));
  });

  it('puts it at the start of the next line when the first line is removed', () => {
    select(at(LINE_1, 4));
    showAsRead(editor, note(LINE_2, LINE_3));

    expect(editor.state.selection.head).toBe(at(LINE_2, 0));
  });

  it('follows its line when the line is moved', () => {
    select(at(LINE_3, 6));
    showAsRead(editor, note(LINE_3, LINE_1, LINE_2));

    expect(editor.state.selection.head).toBe(at(LINE_3, 6));
  });

  it('keeps it after the same words when text before it on its line changes length', () => {
    select(at(LINE_2, LINE_2.length));
    const longer = 'Line 2 of the whole long plan.';
    showAsRead(editor, note(LINE_1, longer, LINE_3));

    expect(editor.state.selection.head).toBe(at(longer, longer.length));
  });

  it('keeps it before the same words when text after it on its line changes', () => {
    select(at(LINE_2, 4));
    const changed = 'Line 2 of another plan.';
    showAsRead(editor, note(LINE_1, changed, LINE_3));

    expect(editor.state.selection.head).toBe(at(changed, 4));
  });

  it('puts it after the new words when the words around it were replaced', () => {
    select(at(LINE_2, 12)); // inside "the"
    const changed = 'Line 2 of a plan.';
    showAsRead(editor, note(LINE_1, changed, LINE_3));

    expect(editor.state.selection.head).toBe(at(changed, 'Line 2 of a'.length));
  });

  it('keeps a range selection, each end mapped', () => {
    select(at(LINE_1, 5), at(LINE_3, 4));
    showAsRead(editor, note('Theirs, on top.', LINE_1, LINE_2, LINE_3));

    expect(editor.state.selection.anchor).toBe(at(LINE_1, 5));
    expect(editor.state.selection.head).toBe(at(LINE_3, 4));
  });

  it('puts it in the one empty line when the note is emptied', () => {
    select(at(LINE_3, 4));
    showAsRead(editor, note(''));

    expect(editor.state.doc.textContent).toBe('');
    expect(editor.state.selection.head).toBe(1);
  });

  it('puts it at the start, not the end, when an empty note fills', () => {
    editor.commands.setContent(note('') as object);
    select(1);
    showAsRead(editor, note(LINE_1, LINE_2));

    expect(editor.state.selection.head).toBe(at(LINE_1, 0));
  });

  it('neither emits an update (no save) nor adds an undo step', () => {
    select(at(LINE_2, 4));
    const updates = vi.fn();
    editor.on('update', updates);
    showAsRead(editor, note(LINE_1, LINE_2, 'Theirs, added outside.'));

    expect(updates).not.toHaveBeenCalled();
    expect(editor.can().undo()).toBe(false);
  });
});

describe('showAsRead in an editor without focus: the next page caret is read (#877)', () => {
  /** The text node of the line that reads `text`. */
  function textOf(text: string): Text {
    const line = [...editor.view.dom.querySelectorAll('p')].find((p) => p.textContent === text);
    const node = line?.firstChild;
    if (!(node instanceof Text)) throw new Error(`No line reads "${text}".`);
    return node;
  }

  /** The page's caret put at `offset` into `node`, and ProseMirror told of it. */
  function pageCaret(node: Text, offset: number): void {
    document.getSelection()?.collapse(node, offset);
    document.dispatchEvent(new Event('selectionchange'));
  }

  it('reads a page caret put back on the spot it last read', () => {
    const outside = document.body.appendChild(document.createElement('button'));
    editor.view.dom.focus();
    const line = textOf(LINE_2);
    pageCaret(line, 12);
    expect(editor.state.selection.head).toBe(at(LINE_2, 12));
    // The tab is hidden: the editor loses focus, and the note is re-read.
    outside.focus();
    const changed = 'Line 2 of a plan.';
    showAsRead(editor, note(LINE_1, changed, LINE_3));
    // Shown again: the text node is the one the editor last read in.
    expect(textOf(changed)).toBe(line);
    expect(editor.state.selection.head).not.toBe(at(changed, 12));

    editor.view.dom.focus();
    pageCaret(line, 12);

    expect(editor.state.selection.head).toBe(at(changed, 12));
  });
});
