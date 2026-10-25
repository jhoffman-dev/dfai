import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/*
 * Room to type beside an image (#568). An image is an atom in its line, and
 * WebKit will not put the caret after one at the end of a line, so a note
 * that ends in an image had nowhere to type after it. These give it a line:
 * Enter or ↓ on a selected image, or a click below the last one, moves to
 * an empty line after it (making one if there is none), and ↑ on an image at
 * the very top makes one before it. An empty line is written as nothing.
 */

/** The selected image, and the paragraph it is in at the top of the note; null otherwise. */
function selectedImage(state: EditorState): { at: number; line: PmNode; lineStart: number } | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'image') return null;
  const $at = selection.$from;
  if ($at.depth !== 1 || $at.parent.type.name !== 'paragraph') return null;
  return { at: selection.from, line: $at.parent, lineStart: $at.before(1) };
}

/** Puts the caret on the empty line after the block ending at `after`, making one if needed. */
function moveToLineAfter(view: EditorView, after: number): void {
  const { state } = view;
  const next = state.doc.resolve(after).nodeAfter;
  const tr = state.tr;
  if (next === null || next.type.name !== 'paragraph' || next.content.size > 0) {
    tr.insert(after, state.schema.nodes['paragraph']!.create());
  }
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
}

/** Enter on a selected image: an image last in its line goes on to an empty line; any other splits after it. */
export function enterAfterImage(editor: Editor): boolean {
  const image = selectedImage(editor.state);
  if (image === null) return false;
  const lineEnd = image.lineStart + image.line.nodeSize;
  const afterImage = image.at + 1;
  if (afterImage === lineEnd - 1) {
    moveToLineAfter(editor.view, lineEnd);
    return true;
  }
  return editor.chain().setTextSelection(afterImage).splitBlock().run();
}

/** ↓ on a selected image in the note's last line, which has nowhere else to go. */
export function downFromLastImage(editor: Editor): boolean {
  const image = selectedImage(editor.state);
  if (image === null) return false;
  const lineEnd = image.lineStart + image.line.nodeSize;
  if (lineEnd !== editor.state.doc.content.size) return false;
  moveToLineAfter(editor.view, lineEnd);
  return true;
}

/** ↑ on a selected image that starts the note's first line: a line before it. */
export function upFromFirstImage(editor: Editor): boolean {
  const image = selectedImage(editor.state);
  if (image === null || image.lineStart !== 0 || image.at !== 1) return false;
  const { state, view } = editor;
  const tr = state.tr.insert(0, state.schema.nodes['paragraph']!.create());
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 1)).scrollIntoView());
  return true;
}

/** Whether the note's last block is a line ending in an image. */
function endsInImage(doc: PmNode): boolean {
  const last = doc.lastChild;
  return last?.type.name === 'paragraph' && last.lastChild?.type.name === 'image';
}

/**
 * A click below the note's last line, when that line ends in an image, goes
 * to a line after it. Only a click on the editor itself, in the room the
 * stylesheet leaves under such a line, rather than on anything in it.
 */
export const imageRoomPlugin = () =>
  new Plugin({
    key: new PluginKey('imageRoom'),
    props: {
      handleDOMEvents: {
        mousedown: (view, event) => {
          if (!view.editable || event.button !== 0 || event.target !== view.dom) return false;
          if (!endsInImage(view.state.doc)) return false;
          const last = view.nodeDOM(
            view.state.doc.content.size - view.state.doc.lastChild!.nodeSize,
          );
          if (
            !(last instanceof HTMLElement) ||
            event.clientY <= last.getBoundingClientRect().bottom
          ) {
            return false;
          }
          event.preventDefault();
          moveToLineAfter(view, view.state.doc.content.size);
          view.focus();
          return true;
        },
      },
    },
  });
