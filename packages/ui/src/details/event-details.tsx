import { useState, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import type { ActivityLevel } from '@dfai/domain';

/** A warning or an error, said whole (#815): what its one line had no room for. */
export interface EventDetailsView {
  readonly level: ActivityLevel;
  /** "Today, 14:03", as the person reads it. */
  readonly time: string;
  /** The same moment for `<time>`, in ISO form. */
  readonly dateTime: string;
  /** The message, never cut short here. */
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

type Copying = 'idle' | 'copied' | 'refused';

/**
 * A short line that opens to its details (#815): the words of a warning or an
 * error as a button, and the popup they open — level, time, the whole
 * message, what it is about, and whatever else the event carries, with a
 * button to copy it all. A button, so Tab reaches it and Enter or Space
 * opens it; Esc or a press outside closes it, and the focus goes back to the
 * line. It says `tabindex="0"`: WebKit Tabs to no button that does not (#468).
 */
export function EventDetailsButton({
  details,
  className,
  children,
  onCopy,
  onOpenSubject,
  onOpenChange,
}: {
  details: EventDetailsView;
  className?: string;
  /** The line's words. */
  children: ReactNode;
  /** Puts the text on the clipboard; rejects when the clipboard refuses. */
  onCopy: (text: string) => Promise<void>;
  /** Opens what the event is about; absent where nothing can be opened. */
  onOpenSubject?: () => void;
  /** Told as the popup opens and closes, for a line that must stay while it is read. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <Dialog.Root open={open} onOpenChange={change}>
      <Dialog.Trigger
        className={`event-details-button${className === undefined ? '' : ` ${className}`}`}
        tabIndex={0}
      >
        {children}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Viewport className="palette__backdrop">
          <Dialog.Popup className="palette confirm event-details">
            <Popup
              details={details}
              onCopy={onCopy}
              {...(onOpenSubject !== undefined && {
                onOpenSubject: () => {
                  change(false);
                  onOpenSubject();
                },
              })}
            />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
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
  const [copying, setCopying] = useState<Copying>('idle');
  const copy = () =>
    void onCopy(details.text).then(
      () => setCopying('copied'),
      // Said beside the button: the text is still on screen to select by hand.
      () => setCopying('refused'),
    );
  return (
    <>
      <div className="event-details__head">
        <Dialog.Title className="visually-hidden">{LEVEL_LABELS[level]} details</Dialog.Title>
        <span className={`event-details__level event-details__level--${level}`}>
          {LEVEL_LABELS[level]}
        </span>
        <time className="event-details__time" dateTime={dateTime}>
          {time}
        </time>
      </div>
      <p className="event-details__message">{message}</p>
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
