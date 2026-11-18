import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { Icon } from '../icon.tsx';
import { noticeBarClass } from '../notice-bar.ts';
import { AssistRow, type AssistRowActions, type AssistRowView } from './assist-row.tsx';

export type { AssistRowAction, AssistRowView } from './assist-row.tsx';

/** What Suggest has to show (#900), once it was pressed. */
export type AssistView =
  | { readonly kind: 'asking' }
  | {
      readonly kind: 'plan';
      readonly summary: string;
      readonly rows: readonly AssistRowView[];
      /** A line about the items not looked at, or null. */
      readonly more: string | null;
      /** Whether any row can be applied: "Apply all sure ones" is offered. False when left out. */
      readonly canApplyAll?: boolean;
      /** Whether any row is applied and can be taken back: "Undo all" is offered. False when left out. */
      readonly canUndoAll?: boolean;
      /** True while rows are being applied or undone: the bar's buttons wait. */
      readonly busy?: boolean;
      /** What the last apply or undo did, said for a screen reader as it lands. */
      readonly said?: string;
    }
  | { readonly kind: 'not-now'; readonly message: string };

/** What the panel's buttons do (#909); left out where nothing can be applied. */
export interface AssistActions extends AssistRowActions {
  readonly onApplyAll: () => void;
  readonly onUndoAll: () => void;
}

export interface AssistSummaryProps {
  readonly view: AssistView;
  readonly onDismiss: () => void;
  readonly actions?: AssistActions | null;
}

/**
 * What Inbox assist would do (#900): the sentence that sums it up, then each
 * item with what would be done and why. Nothing is written until a row's
 * Apply, or "Apply all sure ones", is pressed (#909); each applied row has
 * Undo, and the panel "Undo all". Dismiss, or Escape anywhere in it, puts it away. It takes the focus as it opens, on its
 * heading, so the keyboard follows Suggest to what it shows (#903).
 */
export function AssistSummary({ view, onDismiss, actions = null }: AssistSummaryProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
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
        <h3 className="inbox-assist__heading" tabIndex={-1} ref={heading}>
          Suggestions
        </h3>
        <AssistBody view={view} actions={actions} />
      </div>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}

function AssistBody({ view, actions }: { view: AssistView; actions: AssistActions | null }) {
  if (view.kind === 'asking') return <p role="status">Asking Claude… nothing is written.</p>;
  if (view.kind === 'not-now') return <p role="status">{view.message}</p>;
  return <AssistPlan view={view} actions={actions} />;
}

function AssistPlan({
  view,
  actions,
}: {
  view: Extract<AssistView, { kind: 'plan' }>;
  actions: AssistActions | null;
}) {
  const id = useId();
  const { summary, rows, more } = view;
  return (
    <>
      <p role="status" id={id}>
        <strong>{summary}</strong>{' '}
        <span className="inbox-assist__note">Nothing is written until you apply it.</span>
      </p>
      {rows.length > 0 && (
        <ul className="inbox-assist__rows" aria-labelledby={id}>
          {rows.map((row) => (
            <AssistRow key={row.path} row={row} actions={actions} />
          ))}
        </ul>
      )}
      {more !== null && <p className="inbox-assist__note">{more}</p>}
      {actions !== null && <AllButtons view={view} actions={actions} />}
      <p className="visually-hidden" aria-live="polite">
        {view.said ?? ''}
      </p>
    </>
  );
}

/**
 * "Apply all sure ones" and "Undo all": held, not taken away, while rows are
 * written, so the focus stays on the one pressed and a second press does nothing.
 */
function AllButtons({
  view,
  actions,
}: {
  view: Extract<AssistView, { kind: 'plan' }>;
  actions: AssistActions;
}) {
  if (view.canApplyAll !== true && view.canUndoAll !== true) return null;
  const busy = view.busy === true;
  const unlessBusy = (act: () => void) => () => {
    if (!busy) act();
  };
  return (
    <div className="inbox-assist__all">
      {view.canApplyAll === true && (
        <button
          type="button"
          className="btn btn--sm"
          aria-disabled={busy}
          onClick={unlessBusy(actions.onApplyAll)}
        >
          Apply all sure ones
        </button>
      )}
      {view.canUndoAll === true && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-disabled={busy}
          onClick={unlessBusy(actions.onUndoAll)}
        >
          Undo all
        </button>
      )}
    </div>
  );
}
