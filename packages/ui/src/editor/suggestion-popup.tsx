import { useEffect, useLayoutEffect, useRef } from 'react';
import { placePopup, POPUP_GAP } from '@dfai/domain';
import { Key } from '../key-hints.tsx';
import { onVisibleAreaChange, visibleArea } from '../visible-area.ts';

export interface PopupItem {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** A letter in a circle before the label — a person's initial. */
  readonly avatar?: string;
  /** Listed, with the hint saying why, but not to be picked. */
  readonly disabled?: boolean;
}

/**
 * The list that appears under the caret for `[[` links and `/` commands.
 *
 * Deliberately not a Base UI popover, unlike the other three overlays of
 * ADR-0015. Every behaviour that ADR buys — trapping focus, restoring it,
 * owning open state, dismissing on an outside press, locking the page — is
 * wrong here. Focus must stay in the editor or the caret is lost, the popup is
 * anchored to a caret rectangle rather than to a trigger, and what is open and
 * what is selected are already owned by TipTap's suggestion plugin, which sees
 * the keystrokes before ProseMirror does. All a popover would add is anchored
 * positioning, at the cost of a second owner for the open state.
 *
 * The classes stay `suggest-option` / `atlas-suggestion`: TipTap's decoration
 * defaults to the class `suggestion`, and the collision once moved the caret to
 * column zero.
 */
export function SuggestionPopup({
  label,
  items,
  selected,
  rect,
  onPick,
  hints,
  variant,
}: {
  label: string;
  items: readonly PopupItem[];
  selected: number;
  rect: DOMRect | null;
  /** `other` when the item was picked the other way: Shift-clicked. */
  onPick: (id: string, other: boolean) => void;
  /** The keys the list answers to, along its foot, where there is more than Enter. */
  hints?: readonly (readonly [keys: string, does: string])[];
  /** `blocks`: a note's blocks, each a line or two of what it says (P26-02). */
  variant?: 'notes' | 'blocks';
}) {
  const list = useRef<HTMLUListElement>(null);
  // The list scrolls past 320px and the arrow keys wrap, so the row Enter
  // would pick is brought into view each time it moves; jsdom has no
  // scrollIntoView, hence the guard.
  useEffect(() => {
    const row = list.current?.querySelector('[aria-selected="true"]');
    if (row instanceof HTMLElement && typeof row.scrollIntoView === 'function')
      row.scrollIntoView({ block: 'nearest' });
  }, [selected, items]);

  // Placed against the visible area, not the window: on an iPad the on-screen
  // keyboard covers the lower half without the window knowing, so the list
  // flips above the caret when there is no room under it (#660). Measured and
  // moved before the paint, and again whenever the visible area changes.
  // Where it fits is the domain's (`placePopup`); this reads and writes the DOM.
  useLayoutEffect(() => {
    const element = list.current;
    if (element === null) return;
    const place = () => {
      // Its own height, not the one the last placement held it to.
      element.style.maxHeight = '';
      const placed = placePopup({
        anchor: { top: rect?.top ?? 0, left: rect?.left ?? 0, width: 0, height: rect?.height ?? 0 },
        size: { width: element.offsetWidth, height: element.offsetHeight },
        visible: visibleArea(),
      });
      element.style.top = `${placed.top}px`;
      element.style.left = `${placed.left}px`;
      element.style.maxHeight = placed.maxHeight === null ? '' : `${placed.maxHeight}px`;
      element.dataset.flipped = placed.flipped ? 'true' : 'false';
    };
    place();
    return onVisibleAreaChange(place);
  }, [rect, items]);

  if (items.length === 0) return null;

  return (
    <ul
      ref={list}
      className={variant === 'blocks' ? 'suggestions suggestions--blocks' : 'suggestions'}
      role="listbox"
      aria-label={label}
      style={{ top: (rect?.bottom ?? 0) + POPUP_GAP, left: rect?.left ?? 0 }}
    >
      {items.map((item, index) => (
        <li key={item.id}>
          <button
            type="button"
            role="option"
            aria-selected={index === selected}
            aria-disabled={item.disabled === true || undefined}
            className={index === selected ? 'suggest-option suggest-option--on' : 'suggest-option'}
            onMouseDown={(event) => {
              // mousedown, not click: the editor would lose the caret first.
              event.preventDefault();
              if (item.disabled !== true) onPick(item.id, event.shiftKey);
            }}
          >
            <span className="suggest-option__name">
              {item.avatar !== undefined && (
                <span className="person-avatar" aria-hidden="true">
                  {item.avatar}
                </span>
              )}
              {item.label}
            </span>
            <span className="suggest-option__path">{item.hint}</span>
          </button>
        </li>
      ))}
      {hints !== undefined && (
        // Decoration for sighted keyboard users, as an overlay's key hints are.
        <li className="suggestions__hints" aria-hidden="true">
          {hints.map(([keys, does]) => (
            <span key={does} className="key-hints__hint">
              {keys.split(' ').map((key) => (
                <Key key={key}>{key}</Key>
              ))}
              {does}
            </span>
          ))}
        </li>
      )}
    </ul>
  );
}
