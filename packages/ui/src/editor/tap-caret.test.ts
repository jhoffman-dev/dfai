// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TapCaret } from './tap-caret.ts';

/*
 * #835: the first tap that focuses a just-opened note must keep its caret.
 * ProseMirror checks 20 ms after focus whether it has read the page's
 * selection, and puts its own back if not. A busy main thread delays the
 * tap's `selectionchange` past that check (60 ms here, as in the forced repro
 * from #834), and the caret jumped to the note's start.
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
  restoreHitTesting();
  editor.destroy();
  document.body.replaceChildren();
  window.removeEventListener('selectionchange', holdSelectionChange, { capture: true });
  vi.useRealTimers();
});

const HIT_TESTING = ['elementFromPoint', 'caretRangeFromPoint'] as const;

/**
 * jsdom has no layout, so no hit testing; ProseMirror's own mousedown handler
 * asks the document where the press landed. Answers it with `offset` into
 * `text` until the test ends.
 */
function stubHitTesting(text: Text, offset: number): void {
  const range = document.createRange();
  range.setStart(text, offset);
  const answers = { elementFromPoint: () => text.parentElement, caretRangeFromPoint: () => range };
  for (const name of HIT_TESTING)
    Object.defineProperty(document, name, { value: answers[name], configurable: true });
}

function restoreHitTesting(): void {
  for (const name of HIT_TESTING) Reflect.deleteProperty(document, name);
}

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

/** ProseMirror's DOM observer, which the extension reads through. */
function observer(): { flush: () => void } {
  return (editor.view as unknown as { domObserver: { flush: () => void } }).domObserver;
}

/** The document position of `offset` characters into `text`. */
function positionIn(text: Text, offset: number): number {
  return editor.view.posAtDOM(text, offset);
}

describe('TapCaret (#835)', () => {
  it('keeps the caret a tap put down when its selectionchange comes after the focus reset', () => {
    const line = secondLine();
    press('touchstart', line, 4);
    selectionChangeAfter(60);

    expect(editor.state.selection.head).toBe(positionIn(line, 4));
    expect(document.getSelection()?.focusNode).toBe(line);
    expect(document.getSelection()?.focusOffset).toBe(4);
  });

  it('keeps the caret a mouse click put down, likewise', () => {
    const line = secondLine();
    stubHitTesting(line, 6);
    press('mousedown', line, 6);
    selectionChangeAfter(60);

    expect(editor.state.selection.head).toBe(positionIn(line, 6));
  });

  it('still puts the editor’s own selection back when focus came without a press', () => {
    // Keyboard focus (Tab) or a script's `dom.focus()`: no press, so the
    // browser's placement is not the person's, and ProseMirror's reset wins as before.
    const line = secondLine();
    const own = positionIn(line, 2);
    editor.commands.setTextSelection(own);
    press(null, line, 9);
    selectionChangeAfter(60);

    expect(editor.state.selection.head).toBe(own);
    expect(document.getSelection()?.focusOffset).toBe(2);
  });

  it('reads nothing once the editor is gone before the check', () => {
    const flush = vi.spyOn(observer(), 'flush');
    press('touchstart', secondLine(), 4);
    editor.destroy();
    vi.advanceTimersByTime(60);

    expect(flush).not.toHaveBeenCalled();
  });
});

describe('TapCaret: which focus a press made (#836)', () => {
  /** Sets the editor's own selection, then focuses it with no press, the browser putting its caret elsewhere. */
  function focusWithoutPress(): { own: number } {
    const line = secondLine();
    const own = positionIn(line, 2);
    editor.commands.setTextSelection(own);
    press(null, line, 9);
    selectionChangeAfter(60);
    return { own };
  }

  function release(kind: 'touchend' | 'touchcancel' | 'mouseup', at: EventTarget): void {
    at.dispatchEvent(new Event(kind, { bubbles: true }));
  }

  it('counts a focus up to 300 ms after the press ends as the press’s', () => {
    editor.view.dom.dispatchEvent(new Event('touchstart', { bubbles: true }));
    release('touchend', editor.view.dom);
    vi.advanceTimersByTime(300);
    const line = secondLine();
    press(null, line, 4);
    selectionChangeAfter(60);

    expect(editor.state.selection.head).toBe(positionIn(line, 4));
  });

  it.each(['touchend', 'touchcancel'] as const)(
    'leaves a focus more than 300 ms after a %s to ProseMirror',
    (end) => {
      editor.view.dom.dispatchEvent(new Event('touchstart', { bubbles: true }));
      release(end, editor.view.dom);
      vi.advanceTimersByTime(301);
      const { own } = focusWithoutPress();

      expect(editor.state.selection.head).toBe(own);
    },
  );

  it('ends a mouse press released outside the editor', () => {
    stubHitTesting(secondLine(), 6);
    editor.view.dom.dispatchEvent(new Event('mousedown', { bubbles: true }));
    editor.view.dom.blur();
    release('mouseup', document.body);
    vi.advanceTimersByTime(301);
    const { own } = focusWithoutPress();

    expect(editor.state.selection.head).toBe(own);
  });

  it('counts a press for its own focus only, not a later one', () => {
    press('touchstart', secondLine(), 4);
    selectionChangeAfter(60);
    release('touchend', editor.view.dom);
    editor.view.dom.blur();
    vi.advanceTimersByTime(100);
    const { own } = focusWithoutPress();

    expect(editor.state.selection.head).toBe(own);
  });
});
