import type { VaultPath } from '@dfai/domain';
import { Icon } from './icon.tsx';

/** A note on a trail, or one it could step to next. */
export interface TrailNote {
  readonly path: VaultPath;
  readonly title: string;
}

/** The trail the pane is walking, as its page draws it over the note. */
export interface TrailWalk {
  /** Every step walked, oldest first. */
  readonly steps: readonly TrailNote[];
  /** The index of the step shown: the note open under the bar. */
  readonly at: number;
  /** Notes this one links with, either way: the next steps by link. */
  readonly linked: readonly TrailNote[];
  /** Notes close in meaning, when they are known: the next steps by meaning. */
  readonly related: readonly TrailNote[];
  /** The saved trail's note, once it has been saved. */
  readonly saved: TrailNote | null;
  /** Why the last save failed, or null. */
  readonly problem: string | null;
  readonly onBack: () => void;
  readonly onForward: () => void;
  /** Goes to the step at an index already walked, keeping every step. */
  readonly onStandOn: (index: number) => void;
  /** Steps on to a note; from an earlier step, that branches. */
  readonly onStep: (path: VaultPath) => void;
  readonly onSave: () => void;
  readonly onOpenSaved: () => void;
  readonly onEnd: () => void;
}

/**
 * The trail being walked (P32-03), over the note it stands on: the steps so
 * far as a path to step back along, and the notes to step to next — by link,
 * and by meaning.
 */
export function TrailBar({ trail }: { trail: TrailWalk }) {
  const { steps, at } = trail;
  return (
    <section className="trail" aria-label="Trail">
      <div className="trail__head">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-label="Step back"
          disabled={at === 0}
          onClick={trail.onBack}
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-label="Step forward"
          disabled={at >= steps.length - 1}
          onClick={trail.onForward}
        >
          <Icon name="chevron-right" size={14} />
        </button>
        <ol className="trail__steps" aria-label="Steps">
          {steps.map((step, index) => (
            <li key={`${index}:${step.path}`}>
              <button
                type="button"
                className="trail__step"
                aria-current={index === at ? 'step' : undefined}
                onClick={() => trail.onStandOn(index)}
              >
                {step.title}
              </button>
            </li>
          ))}
        </ol>
        <button type="button" className="btn btn--secondary btn--sm" onClick={trail.onSave}>
          Save trail
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={trail.onEnd}>
          End trail
        </button>
      </div>
      <TrailStatus trail={trail} />
      <NextSteps title="Linked" notes={trail.linked} onStep={trail.onStep} />
      <NextSteps title="Related" notes={trail.related} onStep={trail.onStep} />
    </section>
  );
}

function TrailStatus({ trail }: { trail: TrailWalk }) {
  if (trail.problem !== null)
    return (
      <p className="trail__status links__empty--error" role="alert">
        {trail.problem}
      </p>
    );
  if (trail.saved === null) return null;
  return (
    <p className="trail__status" role="status">
      Saved as{' '}
      <button type="button" className="trail__saved" onClick={trail.onOpenSaved}>
        {trail.saved.title}
      </button>
    </p>
  );
}

function NextSteps({
  title,
  notes,
  onStep,
}: {
  title: string;
  notes: readonly TrailNote[];
  onStep: (path: VaultPath) => void;
}) {
  if (notes.length === 0) return null;
  return (
    <div className="trail__next" role="group" aria-label={`Next by ${title.toLowerCase()}`}>
      <span className="trail__next-title">{title}</span>
      <ul className="trail__choices">
        {notes.map((note) => (
          <li key={note.path}>
            <button
              type="button"
              className="trail__choice"
              aria-label={`Step to ${note.title}`}
              onClick={() => onStep(note.path)}
            >
              {note.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
