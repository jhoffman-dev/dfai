// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useReturnFocus } from './return-focus.ts';

function focusedButton(): HTMLButtonElement {
  const button = document.createElement('button');
  document.body.append(button);
  button.focus();
  return button;
}

describe('useReturnFocus', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("leaves Base UI's own restore to an opener still in the document", () => {
    focusedButton();
    const fallback = document.createElement('div');
    const { result } = renderHook(() => useReturnFocus(() => fallback));

    expect(result.current()).toBe(true);
  });

  it('hands focus to the fallback once the opener has left the document', () => {
    const opener = focusedButton();
    const fallback = document.createElement('div');
    const { result } = renderHook(() => useReturnFocus(() => fallback));

    opener.remove();

    expect(result.current()).toBe(fallback);
  });

  it('hands focus to the fallback when nothing held it as the dialog opened', () => {
    // WebKit leaves the focus on <body> when a button is clicked.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    const fallback = document.createElement('div');
    const { result } = renderHook(() => useReturnFocus(() => fallback));

    expect(result.current()).toBe(fallback);
  });

  it('hands focus to the fallback when the opener is one the dialog says held nothing', () => {
    // WebKit focuses the nearest focusable ancestor of a clicked button: a frame, not a choice.
    const frame = document.createElement('section');
    frame.tabIndex = -1;
    frame.className = 'frame';
    document.body.append(frame);
    frame.focus();
    const fallback = document.createElement('div');
    const { result } = renderHook(() =>
      useReturnFocus(() => fallback, { unheld: (opener) => opener.classList.contains('frame') }),
    );

    expect(result.current()).toBe(fallback);
  });

  it("falls back to Base UI's restore when there is no fallback to give", () => {
    const opener = focusedButton();
    const { result } = renderHook(() => useReturnFocus(() => null));

    opener.remove();

    expect(result.current()).toBe(true);
  });

  it('remembers the opener from the first render, not from when it closes', () => {
    const opener = focusedButton();
    const fallback = document.createElement('div');
    const { result, rerender } = renderHook(() => useReturnFocus(() => fallback));

    focusedButton();
    rerender();
    opener.remove();

    expect(result.current()).toBe(fallback);
  });
});
