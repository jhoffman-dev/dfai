import type { SkillLineChange } from '@dfai/domain';

/** What Claude's draft would change, line by line, as the domain worked it out. */
export interface SkillDraftPreview {
  /** The name a new skill would take, when it would change; null otherwise. */
  readonly name: string | null;
  readonly description: readonly SkillLineChange[];
  readonly instructions: readonly SkillLineChange[];
  /** Something said beside the draft, such as a name that was ignored; null when nothing is. */
  readonly note: string | null;
}

/** Why an ask gave nothing to accept: each line said, and a fix to copy when there is one. */
export interface SkillAskProblem {
  readonly lines: readonly string[];
  readonly fix: string | null;
}

/**
 * Asking Claude to draft or improve the skill in the editor (#169). Accept
 * only fills the editor's fields; Save is still the one write.
 */
export interface SkillAskView {
  /** Whether the request field is open. */
  readonly open: boolean;
  readonly request: string;
  /** Whether Claude is being asked: Stop is offered. */
  readonly asking: boolean;
  /** Claude's draft, against the editor as it is now; null when there is none. */
  readonly preview: SkillDraftPreview | null;
  readonly problem: SkillAskProblem | null;
  onOpen: () => void;
  onClose: () => void;
  onRequestChange: (request: string) => void;
  onAsk: () => void;
  onStop: () => void;
  onAccept: () => void;
  onDiscard: () => void;
}

const CHANGE_LABEL = { same: 'Unchanged', removed: 'Removed', added: 'Added' } as const;

/** The Ask Claude control: a button, then the request, and Claude's draft to accept or discard. */
export function SkillAsk({ ask, saving }: { ask: SkillAskView; saving: boolean }) {
  if (!ask.open) {
    return (
      <button
        type="button"
        className="btn btn--secondary btn--sm skills__ask-open"
        onClick={ask.onOpen}
      >
        Ask Claude…
      </button>
    );
  }
  const send = () => {
    if (!ask.asking && ask.request.trim() !== '') ask.onAsk();
  };
  return (
    <section className="skills__ask" aria-label="Ask Claude">
      <label className="skills__label">
        <span className="page-form__label">What should Claude do?</span>
        <textarea
          className="field"
          rows={2}
          value={ask.request}
          readOnly={ask.asking}
          placeholder="Make this shorter, or: draft a skill that summarises meeting notes"
          // Its own control: ⌘↩ asks, and Enter never sends the editor's form.
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !event.metaKey) return;
            event.preventDefault();
            send();
          }}
          onChange={(event) => ask.onRequestChange(event.target.value)}
        />
      </label>
      {ask.asking ? (
        <div className="skills__ask-actions">
          <span role="status">Asking Claude…</span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={ask.onStop}>
            Stop
          </button>
        </div>
      ) : (
        ask.preview === null && (
          <div className="skills__ask-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={ask.onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={ask.request.trim() === ''}
              onClick={send}
            >
              Ask
            </button>
          </div>
        )
      )}
      {ask.problem !== null && <AskProblem problem={ask.problem} />}
      {ask.preview !== null && !ask.asking && (
        <DraftPreview
          preview={ask.preview}
          saving={saving}
          canAskAgain={ask.request.trim() !== ''}
          onAccept={ask.onAccept}
          onDiscard={ask.onDiscard}
          onAskAgain={ask.onAsk}
        />
      )}
    </section>
  );
}

function AskProblem({ problem }: { problem: SkillAskProblem }) {
  return (
    <div className="skills__ask-problem" role="alert">
      {problem.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {problem.fix !== null && (
        <p>
          Fix: <code>{problem.fix}</code>
        </p>
      )}
      <p>Nothing in the editor was changed.</p>
    </div>
  );
}

function DraftPreview({
  preview,
  saving,
  canAskAgain,
  onAccept,
  onDiscard,
  onAskAgain,
}: {
  preview: SkillDraftPreview;
  saving: boolean;
  canAskAgain: boolean;
  onAccept: () => void;
  onDiscard: () => void;
  onAskAgain: () => void;
}) {
  return (
    <section className="skills__draft" aria-label="Claude’s draft">
      {preview.note !== null && <p className="skills__hint">{preview.note}</p>}
      {preview.name !== null && (
        <p>
          Name: <strong>{preview.name}</strong>
        </p>
      )}
      <Changes label="Description" changes={preview.description} />
      <Changes label="Instructions" changes={preview.instructions} />
      <p className="skills__hint">
        Accept puts this in the editor. Nothing is saved until you press Save.
      </p>
      <div className="skills__ask-actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onDiscard}>
          Discard
        </button>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={!canAskAgain}
          onClick={onAskAgain}
        >
          Ask again
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={saving}
          onClick={onAccept}
        >
          Accept
        </button>
      </div>
    </section>
  );
}

function Changes({ label, changes }: { label: string; changes: readonly SkillLineChange[] }) {
  const changed = changes.some((change) => change.kind === 'removed' || change.kind === 'added');
  return (
    <div className="skills__diff" role="group" aria-label={label}>
      <span className="page-form__label">{label}</span>
      {changed ? (
        <ul className="skills__diff-lines">
          {changes.map((change, at) => (
            // Lines repeat, and the list is drawn whole each time: the place is the key.
            <li key={at} className={`skills__diff-line skills__diff-line--${change.kind}`}>
              {change.kind === 'folded' ? (
                change.count === 1 ? (
                  '1 unchanged line'
                ) : (
                  `${change.count} unchanged lines`
                )
              ) : (
                <>
                  <span className="visually-hidden">{CHANGE_LABEL[change.kind]}: </span>
                  {change.text === '' ? ' ' : change.text}
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="skills__hint">Unchanged.</p>
      )}
    </div>
  );
}
