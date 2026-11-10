import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { EventDetailsButton, type EventDetailsSource } from './details/index.ts';
import { TOAST_MS, useDismissAfter } from './dismiss-after.ts';
import { Icon } from './icon.tsx';

/**
 * What a toast tells of, drawn as its dot in a muted hue: a change made
 * (green), a warning (amber) — an undo refused, say — or an error (red),
 * which stays until it is sent away, since it must be read.
 */
export type ToastTone = 'change' | 'warning' | 'error';

/**
 * A small word that something happened — "Task added" — bottom right, on a dark
 * surface, with what can be done about it: Undo for a change, an action of
 * the caller's ("Open"), either or both, and a × to send it away. Only the
 * words are the live region, so a screen reader hears what happened and not
 * the names of the buttons. It goes by itself after a few seconds; it never
 * takes the focus, since whatever you were doing is what you are still
 * doing. It waits while the pointer is on it or the focus is in it, so its
 * buttons can be reached, and gives its full time again once let go.
 *
 * A button acts once: the first press does its thing and dismisses, and
 * nothing — a second press, the timer — dismisses again. Its buttons say
 * `tabindex="0"`: WebKit, and so the app's webview, Tabs to no button that
 * does not, and an Undo must be reachable from the keyboard (#468). Saying the same
 * words a second time is the caller's to mark, with a `key` that changes per
 * showing (use-granola-pull's `toastShown`): to a component, the same props
 * are the same showing.
 *
 * A warning or an error given its details opens to them from its words
 * (#815), and stays while they are read. Once they close, the focus is put
 * back on its words. Opened by a pointer from outside it, the toast then has
 * its full time again and goes: that focus was put there, and only a focus
 * the person moves into it holds it. Opened with the focus already in it —
 * from the keyboard — it is held as it was before, by a focus that is the
 * person's own.
 *
 * A toast that goes with the focus in it — timed out, sent away, pushed out —
 * hands the focus to the column it stood in, so it is never left on nothing.
 */
export function Toast({
  message,
  tone,
  action,
  details,
  detailsId,
  onCopy,
  onUndo,
  onDismiss,
}: {
  message: string;
  /** Drawn as a dot before the words; none for a plain word such as "Task added". */
  tone?: ToastTone;
  action?: { readonly label: string; readonly onClick: () => void };
  /** What the words open to; drawn only with `onCopy`, which its popup needs. */
  details?: EventDetailsSource;
  /** The words' own id wherever the toast is drawn, so its open details know it drawn again. */
  detailsId?: string;
  onCopy?: (text: string) => Promise<void>;
  onUndo?: () => void;
  onDismiss: () => void;
}) {
  // The ref answers a second press in the same tick; the state stops the timer.
  const acted = useRef(false);
  const [done, setDone] = useState(false);
  const toast = useRef<HTMLDivElement>(null);
  const { reading, putBack, read, focusMoved, reach } = useDetailsRead(toast);
  useFocusHandedOn(toast);
  const hold = useDismissAfter({
    ms: TOAST_MS,
    showing: message,
    onDismiss,
    stays: done || tone === 'error' || reading,
    focusPutBack: putBack,
  });
  const once = (does?: () => void) => () => {
    if (acted.current) return;
    acted.current = true;
    setDone(true);
    does?.();
    onDismiss();
  };
  return (
    <div
      ref={toast}
      className="toast"
      {...hold}
      {...reach}
      onBlur={(event) => {
        focusMoved();
        hold.onBlur(event);
      }}
    >
      {tone !== undefined && <span className={`toast__dot toast__dot--${tone}`} aria-hidden />}
      <span className="toast__message" role="status">
        {details !== undefined && onCopy !== undefined ? (
          <EventDetailsButton
            details={details}
            {...(detailsId !== undefined && { id: detailsId })}
            className="toast__details"
            onCopy={onCopy}
            onOpenChange={read}
          >
            {message}
          </EventDetailsButton>
        ) : (
          message
        )}
      </span>
      {onUndo !== undefined && (
        <button type="button" className="toast__action" tabIndex={0} onClick={once(onUndo)}>
          <Icon name="undo" size={12} />
          Undo
        </button>
      )}
      {action !== undefined && (
        <button type="button" className="toast__action" tabIndex={0} onClick={once(action.onClick)}>
          {action.label}
        </button>
      )}
      <button
        type="button"
        className="toast__dismiss"
        aria-label="Dismiss"
        tabIndex={0}
        onClick={once()}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

/**
 * Whether the toast's details are being read, and whether the focus on its
 * words once they close was `putBack` there: true only when they were opened
 * from outside the toast, by a pointer. A focus that was in the toast before
 * they opened is the person's own, and goes on holding it.
 */
function useDetailsRead(toast: RefObject<HTMLElement | null>) {
  const [reading, setReading] = useState(false);
  const [putBack, setPutBack] = useState(false);
  const pressedFromOutside = useRef(false);
  const openedFromOutside = useRef(false);
  const focusOutside = () => toast.current?.contains(document.activeElement) !== true;
  return {
    reading,
    putBack,
    read: (open: boolean) => {
      setReading(open);
      setPutBack(!open && openedFromOutside.current);
    },
    /** The focus moved on from where it was put: the next one in the toast is the person's. */
    focusMoved: () => setPutBack(false),
    reach: {
      // Asked as the pointer goes down: where a press focuses a button, it has by the click.
      onPointerDown: () => {
        pressedFromOutside.current = focusOutside();
      },
      onKeyDown: () => {
        pressedFromOutside.current = false;
      },
      onClickCapture: () => {
        openedFromOutside.current = pressedFromOutside.current || focusOutside();
        pressedFromOutside.current = false;
      },
    },
  };
}

/**
 * Hands the focus to the column the toast stood in when the toast goes with
 * the focus in it. Asked as it is taken down, while it is still in the page:
 * afterwards the focus is already the body's.
 */
function useFocusHandedOn(toast: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = toast.current;
    return () => {
      if (element === null || !element.contains(document.activeElement)) return;
      element.parentElement?.focus({ preventScroll: true });
    };
  }, [toast]);
}
