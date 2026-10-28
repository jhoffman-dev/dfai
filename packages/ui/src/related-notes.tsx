import type { VaultPath } from '@dfai/domain';
import { Icon } from './icon.tsx';

/** A note offered as related: close in meaning, not linked yet. */
export interface RelatedRow {
  readonly path: VaultPath;
  readonly title: string;
  /** Why linking it last failed, said on its row. */
  readonly problem?: string;
}

/** Where the Related notes of the open note have got to. */
export type RelatedPanelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'off' }
  | { readonly kind: 'not-built'; readonly done: number; readonly total: number }
  | { readonly kind: 'ready'; readonly notes: readonly RelatedRow[] }
  | { readonly kind: 'failed'; readonly message: string };

/** The Related notes section at a note's foot, as its page is handed it. */
export interface RelatedPanel {
  /** Whether the section is open; it is looked for only while it is. */
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly state: RelatedPanelState;
  /** Writes a `[[link]]` to the note into this one: a suggestion is never a link until then. */
  readonly onAccept: (path: VaultPath) => void;
  /** Hides the suggestion for this note. */
  readonly onDismiss: (path: VaultPath) => void;
  /** Starts a trail from this note; left out where none can be walked. */
  readonly onStartTrail?: () => void;
}

/**
 * The notes close in meaning to this one that are not linked to it yet,
 * each with Link and Dismiss. Drawn only while the section is open.
 */
export function RelatedNotesList({
  panel,
  onOpen,
}: {
  panel: RelatedPanel;
  onOpen: (path: VaultPath) => void;
}) {
  return (
    <div className="links__groups">
      {panel.onStartTrail !== undefined && (
        <button
          type="button"
          className="btn btn--secondary related__trail"
          onClick={panel.onStartTrail}
        >
          Walk a trail from here
        </button>
      )}
      <RelatedBody panel={panel} onOpen={onOpen} />
    </div>
  );
}

function RelatedBody({
  panel,
  onOpen,
}: {
  panel: RelatedPanel;
  onOpen: (path: VaultPath) => void;
}) {
  const { state } = panel;
  if (state.kind !== 'ready') return <RelatedMessage state={state} />;
  if (state.notes.length === 0)
    return (
      <p className="links__empty">Nothing else is close in meaning that is not linked already.</p>
    );
  return (
    <ul className="mentions__list" aria-label="Related notes">
      {state.notes.map((note) => (
        <li key={note.path} className="links__mention">
          <button type="button" className="mentions__link" onClick={() => onOpen(note.path)}>
            <Icon name="doc" size={16} />
            <span className="mentions__name">{note.title}</span>
            <span className="mentions__path">{note.path}</span>
          </button>
          <button
            type="button"
            className="btn btn--secondary links__link-button"
            aria-label={`Link ${note.title} from this note`}
            onClick={() => panel.onAccept(note.path)}
          >
            Link
          </button>
          <button
            type="button"
            className="btn btn--ghost links__link-button"
            aria-label={`Dismiss ${note.title}`}
            onClick={() => panel.onDismiss(note.path)}
          >
            Dismiss
          </button>
          {note.problem !== undefined && (
            <p className="links__empty links__empty--error related__problem" role="alert">
              {note.problem}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function RelatedMessage({ state }: { state: Exclude<RelatedPanelState, { kind: 'ready' }> }) {
  switch (state.kind) {
    case 'loading':
      return <p className="links__empty">Looking…</p>;
    case 'unavailable':
      return (
        <p className="links__empty">
          Related notes need search by meaning, which is not available here.
        </p>
      );
    case 'off':
      return (
        <p className="links__empty">
          Related notes are found by meaning. Turn on “By meaning” in ⌘K to see them.
        </p>
      );
    case 'not-built':
      return (
        <p className="links__empty">
          {state.done < state.total
            ? `Still reading the vault for meaning (${state.done} of ${state.total} notes). This note’s related notes show once it is read.`
            : 'This note has nothing to compare by meaning yet. Write in it, and its related notes show once it is read.'}
        </p>
      );
    case 'failed':
      return (
        <p className="links__empty links__empty--error" role="alert">
          {state.message}
        </p>
      );
  }
}
