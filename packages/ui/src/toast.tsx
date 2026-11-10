import { useRef, useState } from 'react';
import { EventDetailsButton, type EventDetailsView } from './details/index.ts';
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
 * (#815), and stays while they are read. Once they close it has its full
 * time again and then goes, though the focus was put back on its words: only
 * a focus the person moves into it holds it.
 */
export function Toast({
  message,
  tone,
  action,
  details,
  onCopy,
  onUndo,
  onDismiss,
}: {
  message: string;
  /** Drawn as a dot before the words; none for a plain word such as "Task added". */
  tone?: ToastTone;
  action?: { readonly label: string; readonly onClick: () => void };
  /** What the words open to; drawn only with `onCopy`, which its popup needs. */
  details?: EventDetailsView;
  onCopy?: (text: string) => Promise<void>;
  onUndo?: () => void;
  onDismiss: () => void;
}) {
  // The ref answers a second press in the same tick; the state stops the timer.
  const acted = useRef(false);
  const [done, setDone] = useState(false);
  const [reading, setReading] = useState(false);
  // True from the details closing until the focus next moves: it is on the words, put there.
  const [putBack, setPutBack] = useState(false);
  const hold = useDismissAfter({
    ms: TOAST_MS,
    showing: message,
    onDismiss,
    stays: done || tone === 'error' || reading,
    focusPutBack: putBack,
  });
  const read = (open: boolean) => {
    setReading(open);
    setPutBack(!open);
  };
  const once = (does?: () => void) => () => {
    if (acted.current) return;
    acted.current = true;
    setDone(true);
    does?.();
    onDismiss();
  };
  return (
    <div
      className="toast"
      {...hold}
      onBlur={(event) => {
        setPutBack(false);
        hold.onBlur(event);
      }}
    >
      {tone !== undefined && <span className={`toast__dot toast__dot--${tone}`} aria-hidden />}
      <span className="toast__message" role="status">
        {details !== undefined && onCopy !== undefined ? (
          <EventDetailsButton
            details={details}
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
