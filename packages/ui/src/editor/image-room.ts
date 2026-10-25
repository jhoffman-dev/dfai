import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

/*
 * Room to type beside an image (#568). An image is an atom in its line, and
 * WebKit will not put the caret after one at the end of a line, so a note
 * that ends in an image had nowhere to type after it. These give it a line:
 * Enter on a selected image goes on after it, wherever it is; ↓ on the
 * note's last image, or a click below it, moves to an empty line after it
 * (making one if there is none); and ↑ on an image at the very top makes
 * one before it. An empty line is written as nothing.
 */

interface SelectedImage {
  readonly at: number;
  /** How deep its line is: 1 at the top of the note, more in a list, a quote or a callout. */
  readonly depth: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** The selected image and the line it is in; null when no image is selected. */
function selectedImage(state: EditorState): SelectedImage | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'image') return null;
  const $at = selection.$from;
  if (!$at.parent.isTextblock) return null;
  const { depth } = $at;
  return { at: selection.from, depth, lineStart: $at.before(depth), lineEnd: $at.after(depth) };
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

/**
 * Enter on a selected image never replaces it. An image that ends its line,
 * with an empty line after it, goes on to that line. Otherwise the caret goes
 * just after the image and Enter carries on as it does there, so the block
 * the image is in decides: a new item in a list, a new line in a quote, the
 * words after the image (its caption) onto a line of their own.
 */
export function enterAfterImage(editor: Editor): boolean {
  const image = selectedImage(editor.state);
  if (image === null) return false;
  const { view } = editor;
  const next = view.state.doc.resolve(image.lineEnd).nodeAfter;
  const endsLine = image.at + 1 === image.lineEnd - 1;
  if (endsLine && next?.type.name === 'paragraph' && next.content.size === 0) {
    moveToLineAfter(view, image.lineEnd);
    return true;
  }
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, image.at + 1)));
  return false;
}

/** ↓ on a selected image in the note's last line, which has nowhere else to go. */
export function downFromLastImage(editor: Editor): boolean {
  const image = selectedImage(editor.state);
  if (image === null || image.depth !== 1) return false;
  if (image.lineEnd !== editor.state.doc.content.size) return false;
  moveToLineAfter(editor.view, image.lineEnd);
  return true;
}

/** ↑ on a selected image that starts the note's first line: a line before it. */
export function upFromFirstImage(editor: Editor): boolean {
  const image = selectedImage(editor.state);
  if (image === null || image.depth !== 1 || image.lineStart !== 0 || image.at !== 1) return false;
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

/** The class the note's last line is given when it ends in an image: the stylesheet leaves room under it. */
const ROOM_AFTER = 'image-room-after';

function roomDecorations(doc: PmNode): DecorationSet {
  if (!endsInImage(doc)) return DecorationSet.empty;
  const start = doc.content.size - doc.lastChild!.nodeSize;
  return DecorationSet.create(doc, [
    Decoration.node(start, doc.content.size, { class: ROOM_AFTER }),
  ]);
}

/**
 * A click below the note's last line, when that line ends in an image, goes
 * to a line after it. Only a plain click on the editor itself, in the room the
 * stylesheet leaves under such a line, rather than on anything in it; a
 * shift-click there extends the selection as it would anywhere.
 */
export const imageRoomPlugin = () =>
  new Plugin({
    key: new PluginKey('imageRoom'),
    props: {
      decorations: (state) => roomDecorations(state.doc),
      handleDOMEvents: {
        mousedown: (view, event) => {
          if (!view.editable || event.button !== 0 || event.target !== view.dom) return false;
          if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
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
