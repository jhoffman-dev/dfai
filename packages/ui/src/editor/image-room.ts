import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/*
 * Room to type beside an image (#568). An image is an atom in its line, and
 * WebKit will not put the caret after one at the end of a line. A note that
 * ends in an image keeps an empty line after it (trailing-line.ts); these get
 * the caret there: Enter on a selected image goes on after it, wherever it
 * is, and ↓ on the note's last image goes to the line after it. ↑ on an image
 * at the very top makes a line before it. An empty line is written as nothing.
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

/** Where to type on the empty line after the image's line, when the image ends its line and such a line follows; null otherwise. */
function emptyLineAfter(doc: PmNode, image: SelectedImage): number | null {
  const endsLine = image.at + 1 === image.lineEnd - 1;
  const next = doc.resolve(image.lineEnd).nodeAfter;
  if (!endsLine || next === null || next.type.name !== 'paragraph' || next.content.size > 0) {
    return null;
  }
  return image.lineEnd + 1;
}

function moveCaretTo(view: EditorView, at: number): void {
  const { state } = view;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at)).scrollIntoView());
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
  const after = emptyLineAfter(view.state.doc, image);
  if (after !== null) {
    moveCaretTo(view, after);
    return true;
  }
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, image.at + 1)));
  return false;
}

/**
 * ↓ on a selected image that ends its line at the top of the note, with an
 * empty line after it: the caret goes to that line. On the note's last image
 * that is the line kept after it, which WebKit alone does not always reach.
 */
export function downToLineAfterImage(editor: Editor): boolean {
  const image = selectedImage(editor.state);
  if (image === null || image.depth !== 1) return false;
  const after = emptyLineAfter(editor.state.doc, image);
  if (after === null) return false;
  moveCaretTo(editor.view, after);
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
