import { Extension, type Editor } from '@tiptap/core';
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { BLOCK_ANCHOR_ATTR, isBlockId, type EditorDocument } from '@dfai/domain';
import { keepIds } from './block-anchor-keeping.ts';

/**
 * The blocks that can hold a block id (P26-01, ADR-0022): a paragraph, a
 * heading and a list item after their text, and the blocks that carry one on
 * a line after them. Where it can be written is the writer's to say; the editor only
 * keeps the id on the block it names.
 */
const ANCHORED_TYPES = [
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
  'blockquote',
  'callout',
  'codeBlock',
  'queryBlock',
  'table',
  'bulletList',
  'orderedList',
  'taskList',
  'rawBlock',
] as const;

const DATA_ATTRIBUTE = 'data-block-anchor';

/** The meta prosemirror-history marks an undo or a redo with (its plugin's key). */
const HISTORY = 'history$';

/** The meta a document read from its file is shown with: its ids are as the file has them. */
export const READ_FROM_FILE = 'atlas:readFromFile';

/**
 * Shows `doc`, read from its file, in place of what the editor holds. Its ids
 * are taken as the file has them — two blocks holding one id included — as
 * untouched text is (ADR-0003, A26-01).
 *
 * Not a step to undo: the file changed, the person did not type it. Undoing
 * it would put back what the file no longer says — after a promoted line, the
 * line without the task it now names — and save that over the file.
 */
export function showAsRead(editor: Editor, doc: EditorDocument): void {
  editor
    .chain()
    .setMeta(READ_FROM_FILE, true)
    .setMeta('addToHistory', false)
    .setContent(doc as object, { emitUpdate: false })
    .run();
}

/**
 * Carries each block's id (`^abc123`) with the block, off its text: through
 * an edit to its words, a move, and a cut and paste — ProseMirror copies a
 * slice as HTML and reads it back, so the id is written to the HTML too.
 *
 * An id names one block. The half of a block split by Enter that moves on is
 * a new block, and has none; a pasted copy of a block whose id is still in
 * the note has none; and no change gives a block an id another holds. An id
 * the file itself holds twice is left so: untouched text wins (A26-01).
 */
export const BlockAnchor = Extension.create({
  name: 'blockAnchor',

  addGlobalAttributes() {
    return [
      {
        types: [...ANCHORED_TYPES],
        attributes: {
          [BLOCK_ANCHOR_ATTR]: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) => element.getAttribute(DATA_ATTRIBUTE),
            renderHTML: (attrs: Record<string, unknown>) => {
              const id = attrs[BLOCK_ANCHOR_ATTR];
              if (typeof id !== 'string') return {};
              // Drawn faint after the words it follows (A26-01): an item's words are its
              // first paragraph's, which reads it from here. Only an id's own characters
              // reach the style; anything else is not drawn.
              const drawn = isBlockId(id) ? `"^${id}"` : 'none';
              return { [DATA_ATTRIBUTE]: id, style: `--block-anchor: ${drawn}` };
            },
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blockAnchor'),
        props: {
          // A drag within the note keeps its ids: whether it moves is decided only at the
          // drop, after this; a copy's second holder is taken off by keepIds (idsMadeOnce).
          transformPasted: (slice, view) =>
            view.dragging !== null ? slice : withoutIdsHeldBy(view.state.doc, slice),
        },
        appendTransaction: (transactions, before, state) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          if (transactions.some((transaction) => transaction.getMeta(READ_FROM_FILE) === true))
            return null;
          const tr = state.tr;
          // An undo puts ids back where they were; following words there would undo the undo.
          const undoing = transactions.some(
            (transaction) => transaction.getMeta(HISTORY) !== undefined,
          );
          keepIds({ before: before.doc, transactions, tr, undoing });
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
});

/** `slice` with the ids `doc` already holds taken off its blocks, as a paste into `doc` takes them. */
export function withoutIdsHeldBy(doc: ProseMirrorNode, slice: Slice): Slice {
  return withoutIdsIn(slice, idsIn(doc));
}

/** Every block id in the document. */
function idsIn(doc: ProseMirrorNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    const id = node.attrs[BLOCK_ANCHOR_ATTR];
    if (typeof id === 'string') ids.add(id);
  });
  return ids;
}

/** A pasted slice with the ids the note already holds taken off its blocks. */
function withoutIdsIn(slice: Slice, taken: ReadonlySet<string>): Slice {
  const strip = (fragment: Fragment): Fragment => {
    const nodes: ProseMirrorNode[] = [];
    fragment.forEach((node) => {
      if (node.isText) {
        nodes.push(node);
        return;
      }
      const id = node.attrs[BLOCK_ANCHOR_ATTR];
      const content = strip(node.content);
      nodes.push(
        typeof id === 'string' && taken.has(id)
          ? node.type.create({ ...node.attrs, [BLOCK_ANCHOR_ATTR]: null }, content, node.marks)
          : node.copy(content),
      );
    });
    return Fragment.from(nodes);
  };
  return new Slice(strip(slice.content), slice.openStart, slice.openEnd);
}
