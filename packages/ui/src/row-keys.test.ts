// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyboardEvent } from 'react';
import { act, renderHook } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import { typesInto, useRowKeys, useUndoKey } from './row-keys.ts';

/** #109: where a triage key never fires — wherever the key is typed, or another control has the keyboard. */

function placed(html: string): Element {
  document.body.innerHTML = html;
  const target = document.querySelector('[data-target]');
  if (target === null) throw new Error('no target');
  return target;
}

describe('typesInto', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('sleeps in a field: a text box, a date, a select, a text area, anything editable', () => {
    for (const html of [
      '<input data-target>',
      '<input type="date" data-target>',
      '<select data-target></select>',
      '<textarea data-target></textarea>',
    ]) {
      expect(typesInto(placed(html)), html).toBe(true);
    }
    const editable = placed('<div contenteditable="true" data-target></div>') as HTMLElement;
    // jsdom does not work out isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(typesInto(editable)).toBe(true);
  });

  it('sleeps inside a dialog, a menu or a list box, whatever has the focus there', () => {
    for (const role of ['dialog', 'menu', 'listbox']) {
      const html = `<div role="${role}"><button data-target>Pick</button></div>`;
      expect(typesInto(placed(html)), role).toBe(true);
    }
  });

  it('wakes on a row’s own controls: a Done box, a radio, a button, the row itself', () => {
    for (const html of [
      '<input type="checkbox" data-target>',
      '<input type="radio" data-target>',
      '<button data-target>Done</button>',
      '<table><tbody><tr tabindex="-1" data-target><td></td></tr></tbody></table>',
    ]) {
      expect(typesInto(placed(html)), html).toBe(false);
    }
  });
});

describe('useRowKeys — J onto a row the list has yet to draw (PR #641 review)', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  const [drawn, undrawn] = ['Tasks/Drawn.md', 'Tasks/Far.md'].map(createVaultPath) as [
    ReturnType<typeof createVaultPath>,
    ReturnType<typeof createVaultPath>,
  ];
  const press = (key: string) =>
    ({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      target: document.activeElement,
      preventDefault: vi.fn(),
    }) as unknown as KeyboardEvent;

  function keysOver(handle: HTMLElement) {
    const focusRow = vi.fn();
    const { result } = renderHook(() =>
      useRowKeys({
        order: [drawn, undrawn],
        focusRow,
        elementOf: (path) => (path === drawn ? handle : undefined),
        onOpen: vi.fn(),
        undoWaits: () => false,
      }),
    );
    return { rowKey: result.current, focusRow };
  }

  it('takes the focus off the control it is on, so the row takes it as it is drawn, and asks for that row', () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    document.body.append(box);
    box.focus();
    const { rowKey, focusRow } = keysOver(box);
    expect(rowKey(press('j'), drawn)).toBe(true);
    expect(document.activeElement).toBe(document.body);
    expect(focusRow).toHaveBeenCalledWith(undrawn);
  });

  it('leaves the focus where it is for a row already drawn', () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    document.body.append(box);
    box.focus();
    const { rowKey, focusRow } = keysOver(box);
    expect(rowKey(press('k'), undrawn)).toBe(true);
    expect(document.activeElement).toBe(box);
    expect(focusRow).toHaveBeenCalledWith(drawn);
  });
});

describe('useUndoKey — the row taken back (PR #641 attack)', () => {
  const back = createVaultPath('Tasks/Back.md');
  const other = createVaultPath('Tasks/Other.md');

  function undoOver() {
    const focusRow = vi.fn();
    const hook = renderHook(
      ({ order }) =>
        useUndoKey({ order, focusRow, onUndo: async () => back, undoWaits: () => false }),
      { initialProps: { order: [other] } },
    );
    return { ...hook, focusRow };
  }

  it('focuses the row once a list holds it', async () => {
    const { result, rerender, focusRow } = undoOver();
    await act(async () => result.current());
    rerender({ order: [other, back] });
    expect(focusRow).toHaveBeenCalledWith(back);
  });

  it('gives the row up after a few lists without it: a read much later moves no focus', async () => {
    const { result, rerender, focusRow } = undoOver();
    await act(async () => result.current());
    for (let read = 0; read < 3; read += 1) rerender({ order: [other] });
    rerender({ order: [other, back] });
    expect(focusRow).not.toHaveBeenCalled();
  });
});
