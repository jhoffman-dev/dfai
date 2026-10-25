import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode, Slice } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  BLOCK_ACTIONS,
  blockChange,
  blockTargetAt,
  blockTargetOfSelection,
  stillThere,
  type BlockAction,
  type BlockTarget,
} from './block-actions.ts';
import { isHighlight, type HighlightBlocks } from './raw-block.ts';

/*
 * The handle beside a block (#569): a ⋮⋮ in the left gutter of the block
 * under the pointer — each list item has its own, as in Notion — that drags
 * the block and opens its menu. One element for the whole note, moved from
 * block to block by this plugin's view, so hovering draws nothing in React
 * and changes nothing in the document. It hides on a key and comes back
 * with the pointer, so it is never in the way of typing, and it takes no
 * focus: the caret stays in the note until the menu takes it.
 *
 * A drag is ProseMirror's own drag of the block selected whole, so a drop is
 * answered as any drop within the note is (tombstone-guard.ts): moved, it is
 * the same block; copied with ⌥, it is cleaned as a paste is.
 */

/** The event asking for a block's menu, on the editor's element. */
export const BLOCK_MENU_REQUEST = 'atlas:block-menu';

/** The block whose menu is asked for, and the handle it hangs from. */
export interface BlockMenuRequest {
  readonly target: BlockTarget;
  readonly anchor: Element;
}

/** The keys that do each action on the block the caret is in, as its menu does. */
export const BLOCK_ACTION_KEYS: Readonly<Record<BlockAction, string>> = {
  addAbove: 'Alt-Shift-Enter',
  addBelow: 'Alt-Enter',
  duplicate: 'Mod-d',
  moveUp: 'Mod-Shift-ArrowUp',
  moveDown: 'Mod-Shift-ArrowDown',
  delete: 'Mod-Shift-Backspace',
};

/** The key that opens the menu of the block the caret is in. */
export const BLOCK_MENU_KEY = 'Mod-/';

export interface BlockHandleOptions {
  /** A literature note's highlights, which are deleted by its own write; null in any other note. */
  readonly highlights: HighlightBlocks | null;
}

/** Room between the handle and the block's text (or its list's markers), in pixels. */
const GAP = 4;

const handles = new WeakMap<EditorView, HandleView>();

/** Which blocks of the note are highlights, as `highlights` reads them. */
const highlightTest =
  (highlights: HighlightBlocks | null) =>
  (node: ProseMirrorNode): boolean =>
    highlights !== null && isHighlight(highlights, node);

/**
 * Which actions do something to `target` now: a block at the top cannot
 * move up, and a highlight is deleted only where the note can write it.
 */
export function availableBlockActions(
  view: EditorView,
  { target, highlights }: { target: BlockTarget; highlights: HighlightBlocks | null },
): ReadonlySet<BlockAction> {
  const isHighlightNode = highlightTest(highlights);
  return new Set(
    BLOCK_ACTIONS.filter((action) => {
      const change = blockChange(view.state, { target, action, isHighlight: isHighlightNode });
      if (change === null) return false;
      return 'edit' in change || highlights?.remove !== undefined;
    }),
  );
}

/**
 * Does `action` to `target`, if it is still the block there: the edit
 * dispatched as one step, the caret back in the note; a highlight's delete
 * handed to the note's own write. Answers whether anything was done.
 */
export function runBlockAction(
  view: EditorView,
  {
    target,
    action,
    highlights,
  }: { target: BlockTarget; action: BlockAction; highlights: HighlightBlocks | null },
): boolean {
  if (!stillThere(view.state.doc, target)) return false;
  const isHighlightNode = highlightTest(highlights);
  const change = blockChange(view.state, { target, action, isHighlight: isHighlightNode });
  if (change === null) return false;
  if ('highlight' in change) {
    if (highlights?.remove === undefined) return false;
    highlights.remove(change.highlight);
    return true;
  }
  view.dispatch(change.edit);
  view.focus();
  return true;
}

/** Tells the handle its menu closed, so it hides with the pointer again. */
export function blockMenuClosed(view: EditorView): void {
  handles.get(view)?.menuClosed();
}

/** The floating handle, and the pointer it follows. */
class HandleView {
  private readonly handle: HTMLElement;
  private target: BlockTarget | null = null;
  private pointer: { x: number; y: number } | null = null;
  private frame: number | null = null;
  private menuOpen = false;
  private dragging: Slice | null = null;

  constructor(private readonly view: EditorView) {
    this.handle = handleElement();
    // On the document: the editor's element is moved into the page after this view is
    // made (EditorContent), and the gutter the handle sits in is outside the text.
    view.dom.ownerDocument.addEventListener('mousemove', this.onPointerMove, { passive: true });
    view.dom.addEventListener('keydown', this.onKey);
    this.handle.addEventListener('click', this.onClick);
    this.handle.addEventListener('dragstart', this.onDragStart);
    this.handle.addEventListener('dragend', this.onDragEnd);
    handles.set(view, this);
  }

  /** The document changed: the block under the handle may have moved, so it goes until the pointer moves. */
  update(view: EditorView, before: { doc: ProseMirrorNode }): void {
    if (!this.menuOpen && !view.state.doc.eq(before.doc)) this.hide();
  }

  destroy(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.view.dom.ownerDocument.removeEventListener('mousemove', this.onPointerMove);
    this.view.dom.removeEventListener('keydown', this.onKey);
    this.handle.remove();
    handles.delete(this.view);
  }

  /** Opens the menu of the block the caret is in, from the keyboard. */
  openForSelection(): boolean {
    const target = blockTargetOfSelection(this.view.state);
    if (target === null || !this.showAt(target)) return false;
    this.openMenu();
    return true;
  }

  menuClosed(): void {
    this.menuOpen = false;
    this.handle.classList.remove('block-handle--open');
    if (this.pointer === null) this.hide();
  }

  /** What the handle is placed in: the element round the editor's, which the page draws. */
  private get host(): HTMLElement | null {
    return this.view.dom.parentElement;
  }

  private readonly onPointerMove = (event: MouseEvent) => {
    const inside = event.target instanceof Node && this.host?.contains(event.target) === true;
    if (!inside) {
      if (this.pointer !== null) this.onPointerLeave();
      return;
    }
    this.pointer = { x: event.clientX, y: event.clientY };
    // One look per frame, however often the pointer reports.
    this.frame ??= requestAnimationFrame(() => {
      this.frame = null;
      this.follow();
    });
  };

  private readonly onPointerLeave = () => {
    this.pointer = null;
    if (!this.menuOpen && this.dragging === null) this.hide();
  };

  private readonly onKey = () => {
    if (!this.menuOpen) this.hide();
  };

  private readonly onClick = (event: MouseEvent) => {
    event.preventDefault();
    if (this.target !== null) this.openMenu();
  };

  /** The block under the pointer, its handle shown beside it; none past the blocks' edges. */
  private follow(): void {
    if (this.pointer === null || this.menuOpen || this.dragging !== null) return;
    if (!this.view.editable) {
      this.hide();
      return;
    }
    const { x, y } = this.pointer;
    // The gutter is left of the text: the block is looked for on the same line, inside the note.
    const left = Math.max(x, this.view.dom.getBoundingClientRect().left + 1);
    const at = this.view.posAtCoords({ left, top: y });
    const target = at === null ? null : blockTargetAt(this.view.state.doc, at);
    if (this.target !== null && target !== null && sameTarget(this.target, target)) return;
    const box = target === null ? null : this.boxOf(target);
    if (target === null || box === null || y < box.top || y > box.bottom) this.hide();
    else this.showAt(target);
  }

  /** Places the handle beside `target`'s first line; false when the block is not drawn. */
  private showAt(target: BlockTarget): boolean {
    const box = this.boxOf(target);
    const host = this.host?.getBoundingClientRect();
    if (box === null || host === undefined) return false;
    if (this.handle.parentElement !== this.host) this.host?.appendChild(this.handle);
    // Shown before it is measured: a hidden handle has no size.
    this.handle.hidden = false;
    const x = box.left - this.handle.offsetWidth - GAP - host.left;
    const y = box.top + (box.lineHeight - this.handle.offsetHeight) / 2 - host.top;
    this.handle.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.target = target;
    return true;
  }

  /**
   * Where `target` is drawn: its box, the left edge its handle sits off — a
   * list item's list, so the handle is left of the item's marker — and its
   * first line's height.
   */
  private boxOf(target: BlockTarget): BlockBox | null {
    const dom = this.view.nodeDOM(target.pos);
    if (!(dom instanceof HTMLElement)) return null;
    const rect = dom.getBoundingClientRect();
    const list = target.node.type.name.endsWith('Item') ? dom.parentElement : null;
    const line = parseFloat(getComputedStyle(firstLineOf(dom)).lineHeight);
    return {
      left: list?.getBoundingClientRect().left ?? rect.left,
      top: rect.top,
      bottom: rect.bottom,
      lineHeight: Number.isFinite(line) && line < rect.height ? line : rect.height,
    };
  }

  private openMenu(): void {
    const target = this.target;
    if (target === null) return;
    this.menuOpen = true;
    this.handle.classList.add('block-handle--open');
    const detail: BlockMenuRequest = { target, anchor: this.handle };
    this.view.dom.dispatchEvent(new CustomEvent(BLOCK_MENU_REQUEST, { detail }));
  }

  /** ProseMirror's own drag, of the block selected whole: its drop rules answer it. */
  private readonly onDragStart = (event: DragEvent) => {
    const target = this.target;
    const transfer = event.dataTransfer;
    if (target === null || transfer === null || !stillThere(this.view.state.doc, target)) {
      event.preventDefault();
      return;
    }
    const selection = NodeSelection.create(this.view.state.doc, target.pos);
    this.view.dispatch(this.view.state.tr.setSelection(selection));
    const { dom, text, slice } = this.view.serializeForClipboard(selection.content());
    transfer.clearData();
    transfer.setData('text/html', dom.innerHTML);
    transfer.setData('text/plain', text);
    transfer.effectAllowed = 'copyMove';
    const drawn = this.view.nodeDOM(target.pos);
    if (drawn instanceof Element) transfer.setDragImage(drawn, 0, 0);
    // `node` is what ProseMirror's drop deletes on a move: exactly this block.
    const dragging = { slice, move: !event.altKey, node: selection };
    this.view.dragging = dragging;
    this.dragging = slice;
  };

  private readonly onDragEnd = () => {
    // Dropped outside the note, nothing took the drag: it is let go here.
    if (this.view.dragging?.slice === this.dragging) this.view.dragging = null;
    this.dragging = null;
    this.hide();
  };

  private hide(): void {
    this.handle.hidden = true;
    this.target = null;
  }
}

/** Where a block is drawn, as its handle is placed by it. */
interface BlockBox {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
  /** Its first line's height, which the handle is centred on. */
  readonly lineHeight: number;
}

const sameTarget = (one: BlockTarget, other: BlockTarget): boolean =>
  one.pos === other.pos && one.node === other.node;

/** The element whose line height is the block's first line's: a list item's first paragraph. */
function firstLineOf(dom: HTMLElement): Element {
  if (!dom.matches('li')) return dom;
  return dom.querySelector('p') ?? dom;
}

function handleElement(): HTMLElement {
  const handle = document.createElement('div');
  handle.className = 'block-handle';
  handle.hidden = true;
  handle.draggable = true;
  handle.setAttribute('role', 'button');
  handle.setAttribute('aria-label', 'Drag to move, or click for block actions');
  handle.setAttribute('aria-haspopup', 'menu');
  handle.setAttribute('data-block-handle', '');
  handle.textContent = '⋮⋮';
  return handle;
}

/**
 * The handle, and the keys that do what its menu does on the block the
 * caret is in. The keys are the editor's own, so they never reach a field
 * drawn in a block (a highlight's comment), which keeps its keys.
 */
export const BlockHandle = Extension.create<BlockHandleOptions>({
  name: 'blockHandle',

  addOptions() {
    return { highlights: null };
  },

  addKeyboardShortcuts() {
    const { highlights } = this.options;
    const run = (action: BlockAction) => () => {
      const target = blockTargetOfSelection(this.editor.state);
      if (target === null) return false;
      runBlockAction(this.editor.view, { target, action, highlights });
      // Answered either way: a block that cannot move further keeps the key from selecting text.
      return true;
    };
    const keys = Object.fromEntries(
      BLOCK_ACTIONS.map((action) => [BLOCK_ACTION_KEYS[action], run(action)]),
    );
    return {
      ...keys,
      [BLOCK_MENU_KEY]: () => handles.get(this.editor.view)?.openForSelection() ?? false,
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blockHandle'),
        view: (view) => new HandleView(view),
      }),
    ];
  },
});
