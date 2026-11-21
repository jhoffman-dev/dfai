import { useEffect, useRef } from 'react';

/** A rule whose last run can still be undone, as the Automations notice lists it. */
export interface UndoableRun {
  /** The rule's file, which names it to `onUndo`. */
  readonly id: string;
  readonly name: string;
  /** When its last undoable run was, and what it did: `18 Nov 09:00 · Moved 2 notes`. */
  readonly lastRun: string;
}

/**
 * The runs already made that can still be undone, under the notice that
 * Automations is off (#901): switching the feature off stops the rules, and
 * must never leave what they did beyond reach. Each rule's last run is undone
 * as the rule editor's "Undo last run" undoes it.
 *
 * What an undo did, or why it could not, is said in a status region under
 * the list (`said`). A held button is `aria-disabled`, not disabled, so focus
 * stays on it while the undo runs; once its row is gone, focus moves to the
 * next rule's button, or to what was said when none is left (#920).
 */
export function PastRunsUndo({
  runs,
  busy,
  said,
  onUndo,
}: {
  runs: readonly UndoableRun[];
  /** A run or an undo is under way: one at a time. */
  busy: boolean;
  /** What the last undo did, or why it could not; null when nothing is to be said. */
  said: string | null;
  onUndo: (id: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  // The row whose undo was asked for, and where it stood, until its row is gone.
  const asked = useRef<{ id: string; at: number } | null>(null);
  useEffect(() => {
    const undone = asked.current;
    if (undone === null || runs.some((run) => run.id === undone.id)) return;
    asked.current = null;
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [];
    const next = buttons[Math.min(undone.at, buttons.length - 1)];
    (next ?? status.current)?.focus();
  }, [runs]);
  if (runs.length === 0 && said === null) return null;
  return (
    <section className="viewer" aria-labelledby="past-runs-undo">
      <p id="past-runs-undo">
        <strong>Undo what a rule did</strong>
      </p>
      <p>No rule runs while Automations is off. A run already made can still be undone.</p>
      <div role="list" ref={list}>
        {runs.map((run, at) => (
          <div key={run.id} role="listitem" className="settings__row">
            <span className="settings__row-text">
              <span className="settings__row-label">{run.name}</span>
              <span className="settings__status">{run.lastRun}</span>
            </span>
            <button
              type="button"
              className="btn btn--sm"
              aria-label={`Undo last run of ${run.name}`}
              aria-disabled={busy}
              onClick={() => {
                if (busy) return;
                asked.current = { id: run.id, at };
                onUndo(run.id);
              }}
            >
              Undo last run
            </button>
          </div>
        ))}
      </div>
      <p className="settings__status" role="status" ref={status} tabIndex={-1}>
        {said}
      </p>
    </section>
  );
}
