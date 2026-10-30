import { useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { GTD_STATUS_LABELS, type GtdStatus } from '@dfai/domain';
import { MenuItems, type MenuCommand } from './menu-items.tsx';

/** How a row's Move to… menu was first asked for, which decides where its focus starts. */
type MenuOpening = 'pointer' | 'press' | 'arrow';

/** A task row's Move to… button and menu: the statuses the domain offers this task (#111, #107). */
export function MoveMenu({
  title,
  statuses,
  busy,
  holdFocus = false,
  keyShortcut,
  onMove,
}: {
  /** The task's name, which the button and the menu are labelled with. */
  title: string;
  /** The statuses offered, in order. */
  statuses: readonly GtdStatus[];
  busy: boolean;
  /** Held while busy rather than disabled, so a button with the focus keeps it (#107). */
  holdFocus?: boolean;
  /** The key that opens it, where a page has one (#109), for `aria-keyshortcuts`. */
  keyShortcut?: string;
  onMove: (status: GtdStatus) => void;
}) {
  // Built the first time it is opened: a Base UI menu on each of hundreds of
  // rows was most of what a tick drew again (#217). Kept once built, so focus
  // goes back to its button when it shuts.
  const [opening, setOpening] = useState<MenuOpening | null>(null);
  if (opening !== null) {
    return (
      <MoveMenuOpened
        title={title}
        statuses={statuses}
        busy={busy}
        holdFocus={holdFocus}
        onMove={onMove}
        opening={opening}
        {...(keyShortcut !== undefined && { keyShortcut })}
      />
    );
  }
  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm"
      aria-label={`Move ${title} to…`}
      aria-haspopup="menu"
      aria-expanded={false}
      aria-keyshortcuts={keyShortcut}
      {...heldWhile(busy, holdFocus)}
      onKeyDown={(event) => {
        // The built trigger opens on ArrowDown as well as on a press.
        if (event.key !== 'ArrowDown' || busy) return;
        event.preventDefault();
        setOpening('arrow');
      }}
      // Enter and Space press a button with no pointer, which leaves `detail` 0.
      onClick={(event) => {
        if (!busy) setOpening(event.detail === 0 ? 'press' : 'pointer');
      }}
    >
      Move to…
    </button>
  );
}

/**
 * The menu itself. Open state, focus, typeahead and Escape are Base UI's
 * (ADR-0015). Built from a keyboard, its trigger takes the focus the plain
 * button had and is given the same key again, so Base UI opens it as it
 * would from the keyboard — focus on the first item — and not as from a pointer.
 */
function MoveMenuOpened({
  title,
  statuses,
  busy,
  holdFocus,
  onMove,
  opening,
  keyShortcut,
}: {
  title: string;
  statuses: readonly GtdStatus[];
  busy: boolean;
  holdFocus: boolean;
  onMove: (status: GtdStatus) => void;
  opening: MenuOpening;
  keyShortcut?: string;
}) {
  const chosen = useRef<MenuCommand | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const button = trigger.current;
    if (opening === 'pointer' || button === null) return;
    // Before the browser paints: the focus never rests on the page between the two buttons.
    button.focus();
    if (opening === 'press') button.click();
    else {
      button.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    }
  }, [opening]);
  const items = statuses.map((status) => ({
    label: GTD_STATUS_LABELS[status],
    onSelect: () => {
      if (!busy) onMove(status);
    },
  }));
  return (
    <Menu.Root defaultOpen={opening === 'pointer'}>
      <Menu.Trigger
        ref={trigger}
        className="btn btn--ghost btn--sm"
        aria-label={`Move ${title} to…`}
        aria-keyshortcuts={keyShortcut}
        {...heldWhile(busy, holdFocus)}
      >
        Move to…
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="menu-positioner" side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className="menu" aria-label={`Move ${title} to`} render={<ul />}>
            <MenuItems items={items} chosen={chosen} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * Today, pressed while the task is chosen for today: pressing it chooses the
 * task, or takes it off (#108). An element, not a component: each component
 * a row holds is a render the work budgets count.
 */
export function todayToggle({
  title,
  chosen,
  disabled,
  holdFocus = false,
  keyShortcut,
  onToggle,
}: {
  title: string;
  chosen: boolean;
  disabled: boolean;
  /** The key that presses it, where a page has one (#109), for `aria-keyshortcuts`. */
  keyShortcut?: string;
  /** Held while disabled rather than disabled, so a button with the focus keeps it (#107). */
  holdFocus?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm today__choose"
      aria-pressed={chosen}
      aria-label={chosen ? `Take ${title} off today` : `Choose ${title} for today`}
      title={chosen ? 'Take off today' : 'Choose for today'}
      aria-keyshortcuts={keyShortcut}
      {...heldWhile(disabled, holdFocus)}
      onClick={() => {
        if (!disabled) onToggle();
      }}
    >
      Today
    </button>
  );
}

/**
 * A control that takes no press for now: disabled, or — where it may have the
 * focus as it is held, as a query row's do after a press — marked so and kept
 * focusable, since the browser drops the focus of a control it disables.
 */
export function heldWhile(busy: boolean, holdFocus: boolean) {
  if (!holdFocus) return { disabled: busy };
  return busy ? { 'aria-disabled': true as const } : {};
}
