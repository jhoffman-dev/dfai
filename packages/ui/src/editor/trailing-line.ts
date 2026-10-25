import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { isTombstone } from './tombstone-guard.ts';

/*
 * The note ends where the person can type. After a last block that is not a
 * paragraph — a table, a picture, a highlight, a heading — an empty paragraph
 * is kept at the end to type in, as Tiptap's TrailingNode keeps one. Unlike
 * it, a hidden tombstone (ADR-0043 §5) is not where the note ends for the
 * person: a paragraph followed only by tombstones needs nothing after it, so
 * moving a block past them (#569) adds no empty line, and a move up and then
 * down gives the note back exactly as it was. The paragraph is dropped by the
 * save when it is still empty (markdown-blocks.ts).
 */

/** The last block of the note the person can see, or null when there is none. */
function lastVisibleBlock(doc: ProseMirrorNode): ProseMirrorNode | null {
  for (let index = doc.childCount - 1; index >= 0; index -= 1) {
    const block = doc.child(index);
    if (!isTombstone(block)) return block;
  }
  return null;
}

/**
 * Whether the note needs an empty paragraph at its end to type in: after any
 * last block but a paragraph, and after a paragraph that ends in a picture,
 * under which there is otherwise nowhere to type (the picture's own room
 * reads the note's last block, so this holds whatever follows the picture).
 */
export const needsTrailingLine = (doc: ProseMirrorNode): boolean => {
  const last = lastVisibleBlock(doc);
  return last?.type.name !== 'paragraph' || last.lastChild?.type.name === 'image';
};

export const TrailingLine = Extension.create({
  name: 'trailingLine',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('trailingLine'),
        // On every transaction, as TrailingNode was: a note opened on a last atom
        // gets its line on the first, and an undo that brings the atom back gives
        // the note exactly what it had before.
        appendTransaction: (_transactions, _before, state) => {
          const paragraph = state.schema.nodes['paragraph'];
          if (paragraph === undefined || !needsTrailingLine(state.doc)) return null;
          return state.tr.insert(state.doc.content.size, paragraph.create());
        },
      }),
    ];
  },
});
