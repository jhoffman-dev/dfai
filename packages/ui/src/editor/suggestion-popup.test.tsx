// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SuggestionPopup, type PopupItem } from './suggestion-popup.tsx';

afterEach(cleanup);

const NOTES: readonly PopupItem[] = [
  { id: 'Plans/Rome.md', label: 'Rome', hint: 'Plans' },
  { id: 'Plans/Naples.md', label: 'Naples', hint: 'Plans' },
];

function popup(given: Partial<Parameters<typeof SuggestionPopup>[0]> = {}) {
  const onPick = vi.fn();
  render(
    <SuggestionPopup
      label="Link to note"
      items={NOTES}
      selected={0}
      rect={null}
      onPick={onPick}
      {...given}
    />,
  );
  return onPick;
}

describe('a suggestion popup', () => {
  it('is the one popup list, with each row named and its place as the hint', () => {
    popup();
    const list = screen.getByRole('listbox', { name: 'Link to note' });
    expect(list.className).toBe('suggestions');
    const rows = within(list).getAllByRole('option');
    expect(rows.map((row) => row.textContent)).toEqual(['RomePlans', 'NaplesPlans']);
    expect(rows.map((row) => row.className)).toEqual([
      'suggest-option suggest-option--on',
      'suggest-option',
    ]);
  });

  it('hands over the row picked, and whether it was picked the other way', () => {
    const onPick = popup();
    fireEvent.mouseDown(screen.getByRole('option', { name: /Naples/ }));
    expect(onPick).toHaveBeenLastCalledWith('Plans/Naples.md', false);
    fireEvent.mouseDown(screen.getByRole('option', { name: /Rome/ }), { shiftKey: true });
    expect(onPick).toHaveBeenLastCalledWith('Plans/Rome.md', true);
  });

  it('lists its keys along the foot as decoration, outside the options', () => {
    popup({
      hints: [
        ['↵', 'Link'],
        ['⇧ ↵', 'Bookmark'],
      ],
    });
    const list = screen.getByRole('listbox', { name: 'Link to note' });
    expect(within(list).getAllByRole('option')).toHaveLength(2);
    const foot = list.querySelector('.suggestions__hints');
    expect(foot?.getAttribute('aria-hidden')).toBe('true');
    expect(foot?.textContent).toBe('↵Link⇧↵Bookmark');
  });

  it('widens for a note’s blocks', () => {
    popup({ variant: 'blocks', label: 'Link to block' });
    expect(screen.getByRole('listbox', { name: 'Link to block' }).className).toBe(
      'suggestions suggestions--blocks',
    );
  });

  it('draws nothing with nothing to offer', () => {
    popup({ items: [] });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

/**
 * A stand-in for `window.visualViewport`, which jsdom has none of: an iPad's
 * on-screen keyboard shrinks its height and leaves the window's alone (#660).
 */
function fakeVisualViewport(height: number) {
  const viewport = Object.assign(new EventTarget(), {
    offsetTop: 0,
    offsetLeft: 0,
    width: 1180,
    height,
  });
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
  return {
    resizeTo(next: number) {
      viewport.height = next;
      viewport.dispatchEvent(new Event('resize'));
    },
    remove() {
      Reflect.deleteProperty(window, 'visualViewport');
    },
  };
}

/** A caret rectangle 20px tall at `top`, as the suggestion plugin hands one over. */
const caretAt = (top: number, left = 100) =>
  ({ top, bottom: top + 20, left, right: left, height: 20, width: 0 }) as DOMRect;

describe('a suggestion popup against the visible area (#660)', () => {
  const sizes = { offsetWidth: 240, offsetHeight: 320 };
  const own = {
    offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
  };
  // jsdom lays nothing out, so the list is given the size a 320px list has.
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => sizes.offsetWidth,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => sizes.offsetHeight,
    });
  });
  afterEach(() => {
    if (own.offsetWidth)
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', own.offsetWidth);
    if (own.offsetHeight)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', own.offsetHeight);
  });

  it('hangs under the caret while the whole window is visible, as it always did', () => {
    const viewport = fakeVisualViewport(820);
    try {
      popup({ rect: caretAt(100) });
      const list = screen.getByRole('listbox', { name: 'Link to note' });
      expect(list.style.top).toBe('126px');
      expect(list.style.left).toBe('100px');
      expect(list.style.maxHeight).toBe('');
      expect(list.dataset.flipped).toBe('false');
    } finally {
      viewport.remove();
    }
  });

  it('opens above the caret when the keyboard leaves no room under it, and drops back when it goes', () => {
    // 420px visible: the caret at 360 has 34px under it and 354px over it.
    const viewport = fakeVisualViewport(420);
    try {
      popup({ rect: caretAt(360) });
      const list = screen.getByRole('listbox', { name: 'Link to note' });
      expect(list.style.top).toBe(`${360 - 6 - 320}px`);
      expect(list.dataset.flipped).toBe('true');

      viewport.resizeTo(820);
      expect(list.style.top).toBe('386px');
      expect(list.dataset.flipped).toBe('false');
    } finally {
      viewport.remove();
    }
  });

  it('is held to the room there is when neither side has enough, and slides in from the right edge', () => {
    const viewport = fakeVisualViewport(420);
    try {
      // The caret at 240: 234px above, 154px below; and 20px from the right edge.
      popup({ rect: caretAt(240, 1160) });
      const list = screen.getByRole('listbox', { name: 'Link to note' });
      expect(list.style.top).toBe('0px');
      expect(list.style.maxHeight).toBe('234px');
      expect(list.style.left).toBe(`${1180 - 240}px`);
    } finally {
      viewport.remove();
    }
  });
});
