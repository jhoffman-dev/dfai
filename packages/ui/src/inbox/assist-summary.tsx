import { useId, type KeyboardEvent } from 'react';
import { Icon } from '../icon.tsx';
import { noticeBarClass } from '../notice-bar.ts';

/** One item's row, said already: the page decides nothing about it. */
export interface AssistRowView {
  readonly path: string;
  readonly title: string;
  /** What would be done, in DFAI's words. */
  readonly does: string;
  /** One short reason. */
  readonly why: string;
  /** How its chip is drawn: filed, a question, or left. */
  readonly tone: 'file' | 'ask' | 'leave';
}

/** What Suggest has to show (#900), once it was pressed. */
export type AssistView =
  | { readonly kind: 'asking' }
  | {
      readonly kind: 'plan';
      readonly summary: string;
      readonly rows: readonly AssistRowView[];
      /** A line about the items not looked at, or null. */
      readonly more: string | null;
    }
  | { readonly kind: 'not-now'; readonly message: string };

export interface AssistSummaryProps {
  readonly view: AssistView;
  readonly onDismiss: () => void;
}

/** A chip's pastel, from the statuses' own: neutral chrome round it. */
const TONE_PILL: Readonly<Record<AssistRowView['tone'], string>> = {
  file: 'next',
  ask: 'waiting',
  leave: 'backlog',
};

const TONE_WORD: Readonly<Record<AssistRowView['tone'], string>> = {
  file: 'Would file',
  ask: 'Question',
  leave: 'Would leave',
};

/**
 * What Inbox assist would do (#900): the sentence that sums it up, then each
 * item with what would be done and why. Nothing here writes; Dismiss, or
 * Escape anywhere in it, puts it away.
 */
export function AssistSummary({ view, onDismiss }: AssistSummaryProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onDismiss();
  };
  return (
    <section
      className={noticeBarClass('inbox__offer inbox-assist', true)}
      aria-label="Suggestions"
      onKeyDown={onKeyDown}
    >
      <Icon name="spark" size={14} className="notice-bar__icon" />
      <div className="notice-bar__text">
        <AssistBody view={view} />
      </div>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}

function AssistBody({ view }: { view: AssistView }) {
  if (view.kind === 'asking') return <p role="status">Asking Claude… nothing is written.</p>;
  if (view.kind === 'not-now') return <p role="status">{view.message}</p>;
  return <AssistPlan {...view} />;
}

function AssistPlan({ summary, rows, more }: Extract<AssistView, { kind: 'plan' }>) {
  const id = useId();
  return (
    <>
      <p role="status" id={id}>
        <strong>{summary}</strong> <span className="inbox-assist__note">Nothing is written.</span>
      </p>
      {rows.length > 0 && (
        <ul className="inbox-assist__rows" aria-labelledby={id}>
          {rows.map((row) => (
            <li key={row.path} className="inbox-assist__row" aria-label={row.title}>
              <span className="inbox-assist__title">{row.title}</span>
              <span className="status-pill" data-tone={TONE_PILL[row.tone]}>
                {TONE_WORD[row.tone]}
              </span>
              <span className="inbox-assist__does">{row.does}</span>
              {row.why !== '' && <small className="inbox-assist__why">{row.why}</small>}
            </li>
          ))}
        </ul>
      )}
      {more !== null && <p className="inbox-assist__note">{more}</p>}
    </>
  );
}
