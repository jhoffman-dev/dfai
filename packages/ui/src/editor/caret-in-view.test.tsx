// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { useCaretInView } from './caret-in-view.ts';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'visualViewport');
  document.documentElement.style.removeProperty('--keyboard-inset');
  document.body.innerHTML = '';
});

/**
 * A stand-in for `window.visualViewport`: an iPad's keyboard shrinks its
 * height and leaves the window's alone; a pinch-zoom shrinks both of its sides.
 */
function fakeVisualViewport(size: { width?: number; height: number }) {
  const viewport = Object.assign(new EventTarget(), {
    offsetTop: 0,
    offsetLeft: 0,
    width: size.width ?? 1180,
    height: size.height,
  });
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
  return {
    resizeTo(next: { width?: number; height: number }) {
      viewport.width = next.width ?? viewport.width;
      viewport.height = next.height;
      viewport.dispatchEvent(new Event('resize'));
    },
  };
}

/** An editor whose caret is `caretTop` down the page, in a note that scrolls in `.panel__body`. */
function editorWithCaretAt(caretTop: number, { focused = true } = {}) {
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  const scrollBy = vi.fn();
  scroller.scrollBy = scrollBy;
  const dom = document.createElement('div');
  scroller.append(dom);
  document.body.append(scroller);
  const editor = {
    isDestroyed: false,
    state: { selection: { head: 1 } },
    view: {
      dom,
      hasFocus: () => focused,
      coordsAtPos: () => ({ top: caretTop, bottom: caretTop + 20, left: 0, right: 0 }),
    },
  } as unknown as Editor;
  return { editor, scrollBy };
}

const inset = () => document.documentElement.style.getPropertyValue('--keyboard-inset');

describe('useCaretInView (#660)', () => {
  it('makes room under the note for what the keyboard covers, and scrolls the caret above it', () => {
    Object.defineProperty(window, 'innerHeight', { value: 820, configurable: true });
    const viewport = fakeVisualViewport({ height: 820 });
    const { editor, scrollBy } = editorWithCaretAt(700);
    renderHook(() => useCaretInView(editor, { coarsePointer: true }));

    viewport.resizeTo({ height: 420 });
    expect(inset()).toBe('400px');
    // The caret's bottom at 720 plus the 8px margin, against a visible bottom of 420.
    expect(scrollBy).toHaveBeenCalledWith({ top: 308 });
  });

  it('takes the room back when the keyboard goes, without moving the note', () => {
    Object.defineProperty(window, 'innerHeight', { value: 820, configurable: true });
    const viewport = fakeVisualViewport({ height: 420 });
    const { editor, scrollBy } = editorWithCaretAt(100);
    renderHook(() => useCaretInView(editor, { coarsePointer: true }));

    viewport.resizeTo({ height: 820 });
    expect(inset()).toBe('0px');
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('leaves a desktop alone: a window resized with a mouse is not a keyboard (review of PR #744)', () => {
    Object.defineProperty(window, 'innerHeight', { value: 820, configurable: true });
    const viewport = fakeVisualViewport({ height: 820 });
    const { editor, scrollBy } = editorWithCaretAt(700);
    renderHook(() => useCaretInView(editor, { coarsePointer: false }));

    viewport.resizeTo({ height: 420 });
    expect(scrollBy).not.toHaveBeenCalled();
    expect(inset()).toBe('');
  });

  it('leaves a pinch-zoom alone, even on a touch screen: both sides changed', () => {
    Object.defineProperty(window, 'innerHeight', { value: 820, configurable: true });
    const viewport = fakeVisualViewport({ height: 820 });
    const { editor, scrollBy } = editorWithCaretAt(700);
    renderHook(() => useCaretInView(editor, { coarsePointer: true }));

    viewport.resizeTo({ width: 590, height: 410 });
    expect(scrollBy).not.toHaveBeenCalled();
    expect(inset()).toBe('');
  });

  it('does not move a note the caret is not in', () => {
    Object.defineProperty(window, 'innerHeight', { value: 820, configurable: true });
    const viewport = fakeVisualViewport({ height: 820 });
    const { editor, scrollBy } = editorWithCaretAt(700, { focused: false });
    renderHook(() => useCaretInView(editor, { coarsePointer: true }));

    viewport.resizeTo({ height: 420 });
    expect(inset()).toBe('400px');
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('falls back to the window where there is no visualViewport', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1180, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 820, configurable: true });
    const { editor, scrollBy } = editorWithCaretAt(700);
    renderHook(() => useCaretInView(editor, { coarsePointer: true }));

    Object.defineProperty(window, 'innerHeight', { value: 420, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(scrollBy).toHaveBeenCalledWith({ top: 308 });
    // The window is all that can be seen: nothing is known to be under it.
    expect(inset()).toBe('0px');
  });

  it('stops listening when the editor goes', () => {
    const viewport = fakeVisualViewport({ height: 820 });
    const { editor, scrollBy } = editorWithCaretAt(700);
    const { unmount } = renderHook(() => useCaretInView(editor, { coarsePointer: true }));
    unmount();
    viewport.resizeTo({ height: 420 });
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
