import { memo, useId } from 'react';
import { Icon } from './icon.tsx';
import type { InboxOfferReading } from './inbox-offer.ts';
import { noticeBarClass } from './notice-bar.ts';

/** One thing the preview lists: what is written, or what is skipped and why. */
export interface MeetingSetupLineView {
  /** The emails' line is drawn as the field that asks for them. */
  readonly kind: string;
  readonly what: string;
  readonly detail: string;
  /** False when it is there already, or cannot be done: nothing is written for it. */
  readonly written: boolean;
}

export interface MeetingSetupProps extends InboxOfferReading {
  /** Whether the preview is shown, rather than the one-line offer. */
  readonly open: boolean;
  /** What the preview lists; null while the vault is read for it. */
  readonly lines: readonly MeetingSetupLineView[] | null;
  /** Whether the owner's addresses are asked for: none is saved yet. */
  readonly asksEmails: boolean;
  /** Whether the yes would write nothing at all, as the plan says: then there is only Close. */
  readonly writesNothing: boolean;
  /** What is typed in the addresses field. */
  readonly emails: string;
  readonly busy: boolean;
  /** What the yes did, in a sentence or two. */
  readonly result: string | null;
  readonly problem: string | null;
  /** Whether the one-line offer can be put away ("Not now"); where it always stands, it cannot. */
  readonly dismissable?: boolean;
  readonly onOpen: () => void;
  readonly onEmailsChange: (text: string) => void;
  /** The one yes: writes everything the preview lists as written. */
  readonly onAccept: () => void;
  /** Closes the preview, or puts the offer away. */
  readonly onClose: () => void;
  /** Puts away what the yes said. */
  readonly onDismiss: () => void;
}

/**
 * The offer to process meetings when they arrive (#191): one line until
 * asked, then everything one yes would write — the "After a meeting" rule,
 * its prompt, the Meeting and Task types' keys — each marked as written or
 * skipped, and a field for the owner's addresses. Nothing is written until
 * the person says yes; no writes nothing.
 */
export const MeetingSetup = memo(function MeetingSetup(props: MeetingSetupProps) {
  const { open, result, problem } = props;
  return (
    <section
      className={noticeBarClass('inbox__offer task-migration', open)}
      aria-label="Process meetings when they arrive"
    >
      <Icon name="event" size={14} className="notice-bar__icon" />
      <div className="notice-bar__text">
        {!open && result === null && <Offer {...props} />}
        {open && <Preview {...props} />}
        {result !== null && <p role="status">{result}</p>}
        {problem !== null && (
          <p className="table__error" role="alert">
            {problem}
          </p>
        )}
      </div>
      {result !== null && !open && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={props.onDismiss}>
          Dismiss
        </button>
      )}
    </section>
  );
});

function Offer({ onOpen, onClose, dismissable = true }: MeetingSetupProps) {
  return (
    <div className="task-migration__offer">
      <p>
        Process meetings when they arrive: Claude writes a summary at the top of each one, and makes
        your own action items tasks.
      </p>
      <button type="button" className="btn btn--secondary btn--sm" onClick={onOpen}>
        Preview
      </button>
      {dismissable && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
          Not now
        </button>
      )}
    </div>
  );
}

function Preview(props: MeetingSetupProps) {
  const { lines, asksEmails, busy, onAccept, onClose } = props;
  if (lines === null) return <p role="status">Reading what the vault has…</p>;
  const writes = lines.filter((line) => line.written);
  const skips = lines.filter((line) => !line.written);
  const nothing = props.writesNothing;
  return (
    <div className="task-migration__preview">
      <p>
        {nothing
          ? 'Meeting processing is set up already: there is nothing to write.'
          : 'Nothing is written until you say yes. What is there already is skipped.'}
      </p>
      <Lines heading="Written" lines={writes.filter((line) => line.kind !== EMAILS)} />
      {asksEmails && <EmailsField {...props} />}
      <Lines heading="Skipped" lines={skips} />
      <div className="task-migration__actions">
        {!nothing && (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={onAccept}
            disabled={busy}
          >
            Set up
          </button>
        )}
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} disabled={busy}>
          {nothing ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

/** The addresses' line, which the field stands in for. */
const EMAILS = 'emails';

function EmailsField({ lines, emails, busy, onEmailsChange }: MeetingSetupProps) {
  const id = useId();
  const line = lines?.find((one) => one.kind === EMAILS);
  return (
    <div className="task-migration__lines">
      <h3>
        <label htmlFor={id}>Your emails</label>
      </h3>
      {line !== undefined && <small>{line.detail}</small>}
      <textarea
        id={id}
        className="field field--block secrets__field profile__emails"
        placeholder="you@example.com"
        rows={2}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
        value={emails}
        onChange={(event) => onEmailsChange(event.target.value)}
      />
    </div>
  );
}

function Lines({ heading, lines }: { heading: string; lines: readonly MeetingSetupLineView[] }) {
  const id = useId();
  if (lines.length === 0) return null;
  return (
    <div className="task-migration__lines">
      <h3 id={id}>{heading}</h3>
      <ul aria-labelledby={id}>
        {lines.map((line) => (
          <li key={line.what}>
            <b>{line.what}</b>: {line.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}
