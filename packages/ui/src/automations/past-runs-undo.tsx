/** A rule whose last run can still be undone, as the Automations notice lists it. */
export interface UndoableRun {
  /** The rule's file, which names it to `onUndo`. */
  readonly id: string;
  readonly name: string;
  /** When its last undoable run was, and what it did: `18 Nov 09:00 · Moved 3 notes`. */
  readonly lastRun: string;
}

/**
 * The runs already made that can still be undone, under the notice that
 * Automations is off (#901): switching the feature off stops the rules, and
 * must never leave what they did beyond reach. Each rule's last run is undone
 * as the rule editor's "Undo last run" undoes it.
 */
export function PastRunsUndo({
  runs,
  busy,
  onUndo,
}: {
  runs: readonly UndoableRun[];
  /** A run or an undo is under way: one at a time. */
  busy: boolean;
  onUndo: (id: string) => void;
}) {
  if (runs.length === 0) return null;
  return (
    <section className="viewer" aria-labelledby="past-runs-undo">
      <p id="past-runs-undo">
        <strong>Undo what a rule did</strong>
      </p>
      <p>No rule runs while Automations is off. A run already made can still be undone.</p>
      <div role="list">
        {runs.map((run) => (
          <div key={run.id} role="listitem" className="settings__row">
            <span className="settings__row-text">
              <span className="settings__row-label">{run.name}</span>
              <span className="settings__status">{run.lastRun}</span>
            </span>
            <button
              type="button"
              className="btn btn--sm"
              aria-label={`Undo last run of ${run.name}`}
              disabled={busy}
              onClick={() => onUndo(run.id)}
            >
              Undo last run
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
