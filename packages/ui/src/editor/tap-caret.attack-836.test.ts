// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TapCaret } from './tap-caret.ts';
/*
 * Attacks on #835 (PR #836): where the tap-caret read misses a press, loses a
 * caret it should keep, takes one it should not, or throws.
 */

const CONTENT = '<p>Line 1 of the plan.</p><p>Line 2 of the plan.</p>';

let editor: Editor;
let letSelectionChangeThrough = false;

/**
 * Holds back the `selectionchange` jsdom queues itself, so the test says when
 * ProseMirror hears of the selection, as a busy main thread would.
 */
function holdSelectionChange(event: Event): void {
  if (event.type === 'selectionchange' && !letSelectionChangeThrough)
    event.stopImmediatePropagation();
}

beforeEach(() => {
  vi.useFakeTimers();
  window.addEventListener('selectionchange', holdSelectionChange, { capture: true });
  editor = new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: [StarterKit, TapCaret],
    content: CONTENT,
    // jsdom focuses only an element with a tabindex; a browser focuses contenteditable as is.
    editorProps: { attributes: { tabindex: '-1' } },
  });
});

afterEach(() => {
  editor.destroy();
  document.body.replaceChildren();
  window.removeEventListener('selectionchange', holdSelectionChange, { capture: true });
  vi.useRealTimers();
});

/** The text node of the second paragraph, where the tap lands. */
function secondLine(): Text {
  const text = editor.view.dom.querySelectorAll('p')[1]?.firstChild;
  if (!(text instanceof Text)) throw new Error('The second line has no text.');
  return text;
}

/**
 * Focuses the editor the way a browser does on a press: focus first, then the
 * selection moved to where the press landed, all in one task. The
 * `selectionchange` that tells ProseMirror comes `selectionChangeAfter` ms later.
 */
function press(kind: 'touchstart' | 'mousedown' | null, at: Text, offset: number): void {
  if (kind !== null) editor.view.dom.dispatchEvent(new Event(kind, { bubbles: true }));
  editor.view.dom.focus();
  document.getSelection()?.collapse(at, offset);
}

function selectionChangeAfter(ms: number): void {
  vi.advanceTimersByTime(ms);
  letSelectionChangeThrough = true;
  try {
    document.dispatchEvent(new Event('selectionchange'));
  } finally {
    letSelectionChangeThrough = false;
  }
}

/** The document position of `offset` characters into `text`. */
function positionIn(text: Text, offset: number): number {
  return editor.view.posAtDOM(text, offset);
}

/** ProseMirror's DOM observer, which the extension reads through. */
function observer(): { flush: () => void } {
  return (editor.view as unknown as { domObserver: { flush: () => void } }).domObserver;
}

describe('TapCaret attacks (#836)', () => {
  // iOS fires no mouse events for a long-press: only the touchstart, ~500 ms
  // before the focus and the caret it puts down. That press is past the
  // 300 ms window, so the long-press's caret is lost exactly as in #835.
  it('keeps the caret a long-press put down when its selectionchange comes late', () => {
    const line = secondLine();
    editor.view.dom.dispatchEvent(new Event('touchstart', { bubbles: true }));
    vi.advanceTimersByTime(500);
    press(null, line, 4);
    selectionChangeAfter(60);

    expect(editor.state.selection.head).toBe(positionIn(line, 4));
  });

  // A busy main thread delivers a tap, a tap away and a tap back in one batch:
  // the second focus clears the first read, but ProseMirror's check from the
  // first focus still runs at 20 ms and puts its own selection back.
  it('keeps the caret of a second tap when the editor blurred and refocused within 20 ms', () => {
    const line = secondLine();
    press('touchstart', line, 4);
    vi.advanceTimersByTime(5);
    editor.view.dom.blur();
    vi.advanceTimersByTime(5);
    press('touchstart', line, 9);
    selectionChangeAfter(60);

    expect(editor.state.selection.head).toBe(positionIn(line, 9));
  });

  // Focus without a press must leave ProseMirror's selection, as the PR's own
  // test says; but a press inside the already-focused editor, one that made no
  // focus, still counts for a keyboard or script focus up to 300 ms later.
  it('puts the editor’s own selection back on a keyboard focus soon after a press that did not focus', () => {
    const line = secondLine();
    const own = positionIn(line, 2);
    editor.view.dom.focus();
    editor.commands.setTextSelection(own);
    vi.advanceTimersByTime(100);
    editor.view.dom.dispatchEvent(new Event('touchstart', { bubbles: true }));
    editor.view.dom.blur();
    vi.advanceTimersByTime(100);
    press(null, line, 9);
    selectionChangeAfter(60);

    expect(editor.state.selection.head).toBe(own);
  });

  // The read goes through a private of prosemirror-view; a version without it
  // must cost the fix, not throw from a timer on every tap.
  it('degrades without throwing when the DOM observer has no flush', () => {
    const domObserver = observer();
    const flush = domObserver.flush;
    Object.defineProperty(domObserver, 'flush', { value: undefined, configurable: true });
    try {
      press('touchstart', secondLine(), 4);

      expect(() => vi.advanceTimersByTime(25)).not.toThrow();
    } finally {
      Object.defineProperty(domObserver, 'flush', { value: flush, configurable: true });
    }
  });

  it('degrades without throwing when the DOM observer’s flush throws', () => {
    const flush = vi.spyOn(observer(), 'flush').mockImplementation(() => {
      throw new Error('A later prosemirror-view changed its observer.');
    });
    try {
      press('touchstart', secondLine(), 4);

      expect(() => vi.advanceTimersByTime(25)).not.toThrow();
    } finally {
      flush.mockRestore();
    }
  });
});
