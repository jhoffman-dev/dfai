import { Node, type Editor, type NodeViewRenderer } from '@tiptap/core';
import { DOMSerializer, Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import {
  BLOCK_ANCHOR_ATTR,
  isTombstoneBlock,
  withoutBlockIds,
  withoutMarkerLines,
  type HighlightView,
} from '@dfai/domain';
import { READ_FROM_FILE } from './block-anchor.ts';
import { HighlightBlockView } from './highlight-block-view.tsx';
import type { HighlightDrafts, WriteComment } from './highlight-drafts.ts';

/**
 * Which raw blocks offer to open their place elsewhere: a highlight in its
 * literature note offers "Open in PDF" (#506). Asked each time a block is
 * rendered, so the extensions need not be built again when the answer
 * changes; a block already drawn keeps what it was drawn with until it is
 * rendered again.
 */
export interface ReaderLinks {
  /** The link's words for the block with id `id`, or null when it offers none. */
  labelFor(id: string): string | null;
}

/**
 * The highlights of a literature note, which its raw blocks are drawn as
 * (#523): the quote and its comment, the marker hidden. Asked when a block
 * is drawn, from the block itself, so what it shows is its own bytes.
 */
export interface HighlightBlocks {
  /** The highlight the block with this markdown and `^id` is, or null when it is none. */
  viewOf(block: { readonly markdown: string; readonly id: string }): HighlightView | null;
  /**
   * Writes highlight `id`'s comment, as the literature note's own writes do,
   * over `base`, the comment the field started from; rejects with why not,
   * `HighlightCommentChangedError` when the note's comment is not `base` any more.
   */
  editComment: WriteComment;
  /** What is typed in the comment fields and not yet written, kept across redraws. */
  readonly drafts: HighlightDrafts;
  /** An area highlight's picture, found as the note's images are. */
  loadImage(src: string): Promise<string | null>;
  /**
   * Removes highlight `id` by the literature note's own write, which leaves a
   * Kindle highlight's tombstone (ADR-0043 §5); tells the person itself when
   * it cannot. Left out, a highlight is not deleted from its block's menu.
   */
  remove?(id: string): void;
}

export interface RawBlockOptions {
  /** Null where no raw block offers a link: a note read elsewhere, or one that is no literature note. */
  readonly readerLinks: ReaderLinks | null;
  /** Null where no raw block is a highlight: a note read elsewhere, or one that is no literature note. */
  readonly highlights: HighlightBlocks | null;
}

/**
 * A block of markdown the editor does not model — a table, an image, raw HTML.
 * It is an atom: shown as its source and carried through a save untouched, so an
 * unsupported construct is never approximated and quietly rewritten. A
 * highlight in its literature note is one too, drawn as its quote and comment
 * (#523), and saved from its bytes as every raw block is: its comment is
 * written by the literature note's own write, never by the editor's save.
 */
export const RawBlock = Node.create<RawBlockOptions>({
  name: 'rawBlock',
  group: 'block',
  atom: true,
  selectable: true,

  addOptions() {
    return { readerLinks: null, highlights: null };
  },

  addAttributes() {
    return {
      // Read only from `data-markdown`, by the parse rule: a bare `markdown`
      // attribute, which Tiptap would read by default, is not DFAI's.
      markdown: { default: '', parseHTML: () => null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'pre[data-raw-block]',
        // Above the code block's `pre` rule (priority 50), which would otherwise
        // take a pasted raw block and save its source as a fenced block (#541).
        priority: 60,
        // The source is read from its attribute, not the element's text, which
        // also holds the reader link's words. Without one, the rule passes and
        // the code block keeps the text.
        getAttrs: (element) => {
          const markdown = sourceFromAttribute(element.getAttribute('data-markdown'));
          return markdown === null ? false : { markdown };
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('rawBlockPaste'),
        props: {
          // A drag within the note keeps the source: whether it moves (the same
          // block, source and all) is decided only at the drop, after this; a copy
          // is cleaned there as a paste is (tombstone-guard.ts, dropAsCopy).
          transformPasted: (slice, view) =>
            view.dragging !== null ? slice : pastedRawBlocks(slice),
        },
      }),
    ];
  },

  // A paste into another app gets the source: a raw block has no text of its own.
  // DFAI's marker lines, which every reader hides, are left out of it.
  renderText({ node }) {
    return withoutMarkerLines(String(node.attrs['markdown'] ?? ''));
  },

  renderHTML({ node }) {
    return rawBlockSpec(node, this.options.readerLinks);
  },

  addNodeView() {
    const { highlights, readerLinks } = this.options;
    if (highlights === null) return null;
    return highlightOrSource(highlights, readerLinks);
  },
});

/** The block's source, as a `pre`, with its reader link when it offers one. */
function rawBlockSpec(node: ProseMirrorNode, readerLinks: ReaderLinks | null) {
  const markdown = String(node.attrs['markdown'] ?? '');
  const attributes = {
    'data-raw-block': '',
    // Percent-encoded: serialisers leave `<` bare in an attribute, which
    // would put the source's tags into the HTML of a page made from the note.
    'data-markdown': encodeURIComponent(markdown),
    class: classOf(markdown),
    title: 'Not editable yet — saved unchanged',
  };
  const id = node.attrs[BLOCK_ANCHOR_ATTR];
  const label = typeof id === 'string' ? (readerLinks?.labelFor(id) ?? null) : null;
  if (label === null) return ['pre', attributes, markdown] as const;
  return ['pre', attributes, markdown, readerLink(id as string, label)] as const;
}

function classOf(markdown: string): string {
  // A removed highlight's tombstone is hidden by every reader (ADR-0043 §5), and here.
  if (isTombstoneBlock(markdown)) return 'raw-block raw-block--comment raw-block--hidden';
  return isComment(markdown) ? 'raw-block raw-block--comment' : 'raw-block';
}

/**
 * Each block drawn as the highlight it is, or as its source when it is none.
 * Which one is settled when the block is drawn: a block whose bytes change
 * is drawn again, so a source that became a highlight — or stopped being
 * one — is drawn as what it now is.
 */
function highlightOrSource(
  highlights: HighlightBlocks,
  readerLinks: ReaderLinks | null,
): NodeViewRenderer {
  const highlightView = ReactNodeViewRenderer(HighlightBlockView, {
    // The block's bytes may change under the person (a sync, an edit elsewhere): the
    // same highlight is kept, its field and the words typed in it with it.
    update: ({ oldNode, newNode, updateProps }) => {
      if (oldNode.attrs[BLOCK_ANCHOR_ATTR] !== newNode.attrs[BLOCK_ANCHOR_ATTR]) return false;
      if (!isHighlight(highlights, newNode)) return false;
      updateProps();
      return true;
    },
  });
  return (props) => {
    if (isHighlight(highlights, props.node)) {
      const view = highlightView(props);
      builtAsHighlight.add(view.dom);
      return view;
    }
    const { dom } = DOMSerializer.renderSpec(document, rawBlockSpec(props.node, readerLinks));
    return { dom, update: () => false };
  };
}

/**
 * The blocks' DOM that was built as a highlight, known as it is built: the
 * highlight's own view is drawn by React later, so its DOM cannot be asked.
 */
const builtAsHighlight = new WeakSet<globalThis.Node>();

/** Whether the note reads this raw block as a highlight now. */
export function isHighlight(highlights: HighlightBlocks, node: ProseMirrorNode): boolean {
  const id = node.attrs[BLOCK_ANCHOR_ATTR];
  const markdown = String(node.attrs['markdown'] ?? '');
  return typeof id === 'string' && highlights.viewOf({ markdown, id }) !== null;
}

/**
 * A pasted slice with each raw block's source as a paste may bring it: no
 * DFAI marker — a highlight's anchor, a tombstone — which a copy would
 * duplicate or a web page forge, and no block id, which the note may hold
 * already (ADR-0022). A raw block left with nothing is dropped.
 */
export function pastedRawBlocks(slice: Slice): Slice {
  const content = pastedFragment(slice.content);
  if (content === slice.content) return slice;
  if (content.childCount === 0) return Slice.empty;
  // An open side stays open only where its node is still the one it opened into.
  const openStart = content.firstChild === slice.content.firstChild ? slice.openStart : 0;
  const openEnd = content.lastChild === slice.content.lastChild ? slice.openEnd : 0;
  return new Slice(content, openStart, openEnd);
}

function pastedFragment(fragment: Fragment): Fragment {
  let changed = false;
  const children: ProseMirrorNode[] = [];
  fragment.forEach((child) => {
    const pasted = pastedNode(child);
    if (pasted !== child) changed = true;
    if (pasted !== null) children.push(pasted);
  });
  return changed ? Fragment.from(children) : fragment;
}

function pastedNode(node: ProseMirrorNode): ProseMirrorNode | null {
  if (node.type.name !== 'rawBlock') {
    if (node.isLeaf) return node;
    const content = pastedFragment(node.content);
    if (content === node.content) return node;
    // A container left without the content it must hold goes with its raw blocks.
    return node.type.validContent(content) ? node.copy(content) : null;
  }
  const markdown = String(node.attrs['markdown'] ?? '');
  const pasted = withoutBlockIds(withoutMarkerLines(markdown));
  if (pasted === markdown) return node;
  if (pasted.trim() === '') return null;
  return node.type.create({ ...node.attrs, markdown: pasted }, null, node.marks);
}

/** The source `data-markdown` holds, or null without one or with one DFAI did not write. */
const sourceFromAttribute = (encoded: string | null): string | null => {
  if (encoded === null) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    // Not percent-encoding, so not ours: the code block's rule reads it instead.
    return null;
  }
};

/**
 * The block's own link — `[[#^id]]`, a place in this note — which the note's
 * editor follows as any link it is clicked on, so where it leads is the
 * link rules', not the block's.
 */
const readerLink = (id: string, label: string) =>
  [
    'a',
    {
      class: 'raw-block__open wikilink',
      'data-wikilink': '',
      'data-heading': `#^${id}`,
      role: 'link',
      tabindex: '0',
      contenteditable: 'false',
    },
    label,
  ] as const;

/**
 * Whether a raw block is one HTML comment and nothing else — a marker DFAI
 * writes around a meeting's summary (#186), say — which nobody reads: it is
 * drawn small and muted rather than as a block of source.
 */
const isComment = (markdown: string): boolean =>
  /^<!--(?:(?!-->)[\s\S])*-->$/.test(markdown.trim());

/**
 * Draws again the raw blocks whose answer changed: a `%%` typed above a
 * highlight hides it from the note's reading though its own bytes did not
 * change, and one taken away shows it. A block is drawn as a highlight or as
 * its source when it is drawn, so one whose bytes are the same is changed and
 * changed back — neither a step to undo nor a save.
 */
export function redrawHighlightBlocks(editor: Editor, highlights: HighlightBlocks | null): void {
  if (highlights === null) return;
  const { view, state } = editor;
  const stale: number[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'rawBlock') return false;
    const dom = view.nodeDOM(pos);
    const drawnAsHighlight = dom !== null && builtAsHighlight.has(dom);
    if (
      typeof node.attrs[BLOCK_ANCHOR_ATTR] === 'string' &&
      isHighlight(highlights, node) !== drawnAsHighlight
    ) {
      stale.push(pos);
    }
    return false;
  });
  if (stale.length === 0) return;
  // ProseMirror keeps a node view whose node is equal to the one it drew, so the
  // blocks are changed and changed back: each is a step the view draws again.
  const changeBlocks = (positions: readonly number[], change: (markdown: string) => string) => {
    const tr = editor.state.tr;
    for (const pos of positions) {
      const attrs = tr.doc.nodeAt(pos)?.attrs ?? {};
      tr.setNodeMarkup(pos, undefined, { ...attrs, markdown: change(String(attrs['markdown'])) });
    }
    editor.view.dispatch(
      tr
        .setMeta(READ_FROM_FILE, true)
        .setMeta('addToHistory', false)
        .setMeta('preventUpdate', true),
    );
  };
  changeBlocks(stale, (markdown) => `${markdown} `);
  changeBlocks(stale, (markdown) => markdown.slice(0, -1));
}
