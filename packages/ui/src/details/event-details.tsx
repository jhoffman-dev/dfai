import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Dialog } from '@base-ui/react/dialog';
import type { ActivityLevel } from '@dfai/domain';

/** A warning or an error, said whole (#815): what its one line had no room for. */
export interface EventDetailsView {
  readonly level: ActivityLevel;
  /** "Today, 14:03", as the person reads it. */
  readonly time: string;
  /** The same moment for `<time>`, in ISO form. */
  readonly dateTime: string;
  /**
   * The words as the line, the toast or the notice said them, whole: the popup
   * never cuts them. (A line of the log was cut to its length when it was
   * kept; what more it had to say is its `Detail`.)
   */
  readonly message: string;
  /** What it is about, named for its link; null when it links nowhere. */
  readonly subject: string | null;
  /** The named facts the event carries, in the order to read them. */
  readonly details: readonly { readonly label: string; readonly value: string }[];
  /** All of the above as plain text, for the clipboard. */
  readonly text: string;
}

/** What each level is called, on a line and in its details. */
export const LEVEL_LABELS: Readonly<Record<ActivityLevel, string>> = {
  info: 'Info',
  warning: 'Warning',
  error: 'Error',
};

/**
 * A line's details: as they are, or — where they are dated against today, on
 * a line that may be left up past midnight — read as the line is pressed.
 */
export type EventDetailsSource = EventDetailsView | (() => EventDetailsView);

type Copying = 'idle' | 'copied' | 'refused';

/** How long "Copied" is said before the button offers to copy again. */
export const COPIED_MS = 2000;

/** The details one line opened: what it showed as it was pressed, and what its popup can do. */
interface OpenedDetails {
  /** Whose they are: the line that opened them, by its id. */
  readonly line: string;
  readonly details: EventDetailsView;
  readonly onCopy: (text: string) => Promise<void>;
  readonly onOpenSubject?: () => void;
}

export interface DetailsHost {
  /** The line whose details are open; null when none is. */
  readonly open: string | null;
  show(opened: OpenedDetails): void;
  /** Each line drawn now, by its id: where the focus goes back to. */
  readonly lines: Map<string, HTMLElement>;
}

/** What the lines under a host open their details through; given by an `EventDetailsHost`. */
export const EventDetailsContext = createContext<DetailsHost | null>(null);

/**
 * Where the details of the lines under it open (#815): one popup, held here
 * and not by the line, showing what the line said as it was pressed. So it
 * stays open, on the same words, when its line goes or is drawn again
 * somewhere else — a toast pushed out by newer ones, a notice that cleared
 * itself, a line of the log gathered under its meeting. Closing it puts the
 * focus back on the line if it is still drawn, under the same id, and on the
 * host's `landmark` if it is not: the popup has no trigger of its own to go
 * back to, and a focus left to the page's body is lost to the keyboard — and,
 * inside a modal layer, out of its trap.
 *
 * Put one above any lines that can go while they are read; a line with none
 * above it holds its own.
 */
export function EventDetailsHost({
  children,
  landmark,
}: {
  children: ReactNode;
  landmark: DetailsLandmark;
}) {
  const { host, popup } = useEventDetailsHost(landmark);
  return (
    <EventDetailsContext.Provider value={host}>
      {children}
      {popup}
    </EventDetailsContext.Provider>
  );
}

/**
 * Where the focus goes when the line is gone: something focusable that is
 * drawn whatever the lines do — their list, their region. The focus lands on
 * it, itself, and never on something in it that Tab stops on: that would be
 * another line's button, and an Enter meant for the line that went would
 * press it. Null only for a line that hosts itself, whose popup goes with it.
 */
type DetailsLandmark = (() => HTMLElement | null) | null;

/**
 * An `EventDetailsHost` without a component of its own, for a host drawn on
 * every draw of the app — the window's notices and its toasts: `host` is
 * given to an `EventDetailsContext.Provider` above the lines, and `popup` is
 * drawn inside it. Nothing more is drawn until a line first opens — no
 * dialog, no portal — so a window that never opens any details does no work
 * for them (the work budgets count every component drawn, `tools/perf`).
 */
export function useEventDetailsHost(landmark: DetailsLandmark): {
  host: DetailsHost;
  popup: ReactNode;
} {
  const [shown, setShown] = useState<OpenedDetails | null>(null);
  const [open, setOpen] = useState(false);
  const [lines] = useState(() => new Map<string, HTMLElement>());
  const host = useMemo<DetailsHost>(
    () => ({
      open: open ? (shown?.line ?? null) : null,
      show: (opened) => {
        setShown(opened);
        setOpen(true);
      },
      lines,
    }),
    [open, shown, lines],
  );
  const closedByKey = useEscapeTaken(open, setOpen);
  if (shown === null) return { host, popup: null };
  const openSubject = shown.onOpenSubject;
  const popup = (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Viewport className="palette__backdrop">
          <Dialog.Popup
            className="palette confirm event-details"
            finalFocus={(closeType) => {
              // The line as drawn now, which may not be the element that was pressed.
              const line = lines.get(shown.line);
              if (line !== undefined) return line;
              const mark = landmark?.() ?? null;
              if (mark === null) return true;
              // The dialog knows only the closes it made itself: not the Escape taken here, nor
              // a key on "Open subject".
              focusLandmark(mark, closeType === 'keyboard' || closedByKey());
              return false;
            }}
          >
            {/* What was shown stays as the popup leaves, so it never empties on its way out. */}
            <Popup
              details={shown.details}
              onCopy={shown.onCopy}
              {...(openSubject !== undefined && {
                onOpenSubject: () => {
                  setOpen(false);
                  openSubject();
                },
              })}
            />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
  return { host, popup };
}

/**
 * Puts the focus on the landmark itself. Done here and not left to the
 * dialog, which would put it on the first thing in the landmark that Tab
 * stops on, and without scrolling to it: this scrolls it into view, and
 * shows the focus where the keyboard closed the popup (WCAG 2.4.7). After
 * this turn, as the dialog's own hand-back is: its focus trap is down by then.
 */
function focusLandmark(landmark: HTMLElement, byKeyboard: boolean): void {
  queueMicrotask(() => landmark.focus({ focusVisible: byKeyboard }));
}

/**
 * Closes the open popup on Escape, from the moment it is open and wherever
 * the focus is, and marks the key as answered. The dialog's own Escape waits
 * on the focus moving into it: pressed before that, with the line in a peek,
 * the key was the peek's, which closed and left the details up. Heard on the
 * window, on the way down, so it is answered before any layer under the popup
 * hears it; an input method's Escape is left to it.
 *
 * Answers whether a key was the last thing pressed while the popup was open
 * — this Escape, or the Enter on one of its buttons — and not the pointer:
 * what closed it, for the closes the dialog is not told of.
 */
function useEscapeTaken(open: boolean, setOpen: (open: boolean) => void): () => boolean {
  const keyLast = useRef(false);
  useLayoutEffect(() => {
    if (!open) return;
    keyLast.current = false;
    const answer = (event: KeyboardEvent) => {
      keyLast.current = true;
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      setOpen(false);
    };
    const pointed = () => {
      keyLast.current = false;
    };
    window.addEventListener('keydown', answer, true);
    window.addEventListener('pointerdown', pointed, true);
    return () => {
      window.removeEventListener('keydown', answer, true);
      window.removeEventListener('pointerdown', pointed, true);
    };
  }, [open, setOpen]);
  return () => keyLast.current;
}

export interface EventDetailsButtonProps {
  details: EventDetailsSource;
  /**
   * The line's own, kept wherever it is drawn: what lets the focus find it
   * again once its details close. A line that is never drawn again needs none.
   */
  id?: string;
  className?: string;
  /** The whole of words the line cuts short, for a pointer resting on it. */
  title?: string;
  /** The line's words. */
  children: ReactNode;
  /** Puts the text on the clipboard; rejects when the clipboard refuses. */
  onCopy: (text: string) => Promise<void>;
  /** Opens what the event is about; absent where nothing can be opened. */
  onOpenSubject?: () => void;
  /** Told as the popup opens and closes, for a line that must stay while it is read. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * A short line that opens to its details (#815): the words of a warning or an
 * error as a button, and the popup they open — level, time, the whole
 * message, what it is about, and whatever else the event carries, with a
 * button to copy it all. A button, so Tab reaches it and Enter or Space
 * opens it; Esc or a press outside closes it, and the focus goes back to the
 * line. It says `tabindex="0"`: WebKit Tabs to no button that does not (#468).
 *
 * The popup belongs to the `EventDetailsHost` above the line, so it outlives
 * the line; with none above, the line is its own host.
 */
export function EventDetailsButton(props: EventDetailsButtonProps) {
  const hosted = useContext(EventDetailsContext) !== null;
  if (hosted) return <DetailsLine {...props} />;
  return (
    <EventDetailsHost landmark={null}>
      <DetailsLine {...props} />
    </EventDetailsHost>
  );
}

function DetailsLine({
  details,
  id,
  className,
  title,
  children,
  onCopy,
  onOpenSubject,
  onOpenChange,
}: EventDetailsButtonProps) {
  const host = useContext(EventDetailsContext);
  if (host === null) throw new Error('A details line is drawn under an EventDetailsHost.');
  const own = useId();
  const line = id ?? own;
  const open = host.open === line;
  useOpenChangeTold(open, onOpenChange);
  const { lines } = host;
  const drawn = useCallback(
    (button: HTMLButtonElement | null) => {
      if (button === null) return;
      lines.set(line, button);
      return () => {
        // Only its own place: the same line drawn again elsewhere has taken it by then.
        if (lines.get(line) === button) lines.delete(line);
      };
    },
    [lines, line],
  );
  return (
    <button
      ref={drawn}
      type="button"
      className={`event-details-button${className === undefined ? '' : ` ${className}`}`}
      tabIndex={0}
      aria-haspopup="dialog"
      aria-expanded={open}
      {...(title !== undefined && { title })}
      onClick={() =>
        host.show({
          line,
          details: typeof details === 'function' ? details() : details,
          onCopy,
          ...(onOpenSubject !== undefined && { onOpenSubject }),
        })
      }
    >
      {children}
    </button>
  );
}

/**
 * Tells `onOpenChange` each time the line's popup opens or closes. A line
 * first drawn is told nothing — unless its popup is open already: the same
 * line drawn again somewhere else, which must know it is still being read.
 */
function useOpenChangeTold(open: boolean, onOpenChange?: (open: boolean) => void): void {
  const told = useRef(false);
  const tell = useRef(onOpenChange);
  useEffect(() => {
    tell.current = onOpenChange;
  });
  useEffect(() => {
    if (told.current === open) return;
    told.current = open;
    tell.current?.(open);
  }, [open]);
}

function Popup({
  details,
  onCopy,
  onOpenSubject,
}: {
  details: EventDetailsView;
  onCopy: (text: string) => Promise<void>;
  onOpenSubject?: () => void;
}) {
  const { level, time, dateTime, message } = details;
  const [copying, copy] = useCopying(() => onCopy(details.text));
  return (
    <>
      <div className="event-details__head">
        <Dialog.Title className="visually-hidden">{LEVEL_LABELS[level]} details</Dialog.Title>
        {/* Hidden from a screen reader: the popup's name has said the level already. */}
        <span className={`event-details__level event-details__level--${level}`} aria-hidden>
          {LEVEL_LABELS[level]}
        </span>
        <time className="event-details__time" dateTime={dateTime}>
          {time}
        </time>
      </div>
      {/* `dir="auto"`: the words may be a file's or a server's, in a right-to-left script. */}
      <p className="event-details__message" dir="auto">
        {message}
      </p>
      <Facts details={details} {...(onOpenSubject !== undefined && { onOpenSubject })} />
      <div className="confirm__actions">
        {copying === 'refused' && (
          <span className="event-details__refused" role="alert">
            Could not copy.
          </span>
        )}
        <button type="button" className="btn btn--secondary" tabIndex={0} onClick={copy}>
          {copying === 'copied' ? 'Copied' : 'Copy'}
        </button>
        <Dialog.Close className="btn btn--secondary" tabIndex={0}>
          Close
        </Dialog.Close>
      </div>
    </>
  );
}

/** How a copy went, and the press that makes one; "copied" is said for `COPIED_MS`, then no more. */
function useCopying(write: () => Promise<void>): [Copying, () => void] {
  const [copying, setCopying] = useState<Copying>('idle');
  useEffect(() => {
    if (copying !== 'copied') return;
    const timer = window.setTimeout(() => setCopying('idle'), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copying]);
  const copy = () =>
    // Inside a promise, so a clipboard that throws — the web build has none on plain http — refuses too.
    void new Promise<void>((resolve) => resolve(write())).then(
      () => setCopying('copied'),
      // Said beside the button: the text is still on screen to select by hand.
      () => setCopying('refused'),
    );
  return [copying, copy];
}

/** What the event is about, linked where it can be opened, then each fact it carries. */
function Facts({
  details: { subject, details },
  onOpenSubject,
}: {
  details: EventDetailsView;
  onOpenSubject?: () => void;
}) {
  if (subject === null && details.length === 0) return null;
  return (
    <dl className="event-details__facts">
      {subject !== null && (
        <div className="event-details__fact">
          <dt>About</dt>
          <dd>
            {onOpenSubject === undefined ? (
              subject
            ) : (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                tabIndex={0}
                onClick={onOpenSubject}
              >
                Open {subject}
              </button>
            )}
          </dd>
        </div>
      )}
      {details.map(({ label, value }, at) => (
        <div key={`${at}:${label}`} className="event-details__fact">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
