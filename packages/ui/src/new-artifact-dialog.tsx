import type { KeyboardEvent } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { holdModalLayer } from './modal-layer.ts';
import { FileDrop } from './file-drop.tsx';
import { Icon, type IconName } from './icon.tsx';
import { isImeKey } from './ime.ts';
import { KeyHints } from './key-hints.tsx';
import { useReturnFocus, type FocusFallback } from './return-focus.ts';

const HINTS = [
  ['↵', 'to save'],
  ['esc', 'to close'],
] as const;

/** What the dialog holds while it is being filled in. */
export interface NewArtifactDraft {
  readonly url: string;
  readonly title: string;
  readonly kind: string;
  /** The project's note name, or '' for none. */
  readonly project: string;
  /** The page and its files, when a copy is being saved. */
  readonly files: readonly File[];
}

export interface ArtifactChoice {
  readonly value: string;
  readonly label: string;
}

/** Why only the link is kept without a file, in the words the dialog uses. */
export const LINK_ONLY_NOTE =
  'Only the link is saved. Ask Claude to save a copy, or drop the HTML file here.';

/** How each kind of artifact is drawn. */
const KIND_GLYPHS: Readonly<Record<string, IconName>> = {
  page: 'artifact',
  deck: 'deck',
  design: 'design',
  doc: 'doc',
  other: 'artifact',
};

export function artifactKindGlyph(kind: string): IconName {
  return KIND_GLYPHS[kind] ?? 'artifact';
}

/**
 * Saving an artifact: its link, its name, what it is and whose project, and —
 * dropped or picked — the page itself. Everything is decided outside: the
 * kind guessed from the link or the page, and why a save was refused.
 */
export function NewArtifactDialog({
  draft,
  kinds,
  projects,
  error,
  saving,
  onChange,
  onCreate,
  onClose,
  fallbackFocus,
}: {
  draft: NewArtifactDraft;
  kinds: readonly ArtifactChoice[];
  projects: readonly ArtifactChoice[];
  error: string | null;
  saving: boolean;
  onChange: (draft: NewArtifactDraft) => void;
  onCreate: () => void;
  onClose: () => void;
  fallbackFocus?: FocusFallback;
}) {
  const finalFocus = useReturnFocus(fallbackFocus);
  const ready = draft.title.trim() !== '' && !saving;
  const submitOnEnter = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !isImeKey(event) && ready) onCreate();
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal ref={holdModalLayer}>
        <Dialog.Viewport className="palette__backdrop">
          <Dialog.Popup className="palette new-type new-artifact" finalFocus={finalFocus}>
            <Dialog.Title className="new-type__title">New artifact</Dialog.Title>
            <div className="palette__field">
              <Icon name="link" size={19} className="palette__field-icon" />
              <input
                className="palette__input"
                type="url"
                aria-label="Link"
                placeholder="https://claude.ai/artifact/…"
                value={draft.url}
                onChange={(event) => onChange({ ...draft, url: event.target.value })}
                onKeyDown={submitOnEnter}
              />
            </div>
            <label className="new-view__field">
              <span className="new-type__legend">Title</span>
              <input
                className="field"
                type="text"
                aria-label="Title"
                placeholder="Q3 sales deck"
                value={draft.title}
                onChange={(event) => onChange({ ...draft, title: event.target.value })}
                onKeyDown={submitOnEnter}
              />
            </label>
            <KindChoices draft={draft} kinds={kinds} onChange={onChange} />
            <ProjectChoice draft={draft} projects={projects} onChange={onChange} />
            <CopyChoice draft={draft} saving={saving} onChange={onChange} />
            {error !== null && (
              <p className="new-type__error" role="alert">
                {error}
              </p>
            )}
            <div className="new-type__actions">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!ready}
                onClick={onCreate}
              >
                {saving ? 'Saving…' : 'Save artifact'}
              </button>
            </div>
            <KeyHints hints={HINTS} />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function KindChoices({
  draft,
  kinds,
  onChange,
}: {
  draft: NewArtifactDraft;
  kinds: readonly ArtifactChoice[];
  onChange: (draft: NewArtifactDraft) => void;
}) {
  return (
    <fieldset className="new-view__layouts">
      <legend className="new-type__legend">Kind</legend>
      {kinds.map((kind) => (
        <button
          key={kind.value}
          type="button"
          className="new-view__layout"
          aria-pressed={draft.kind === kind.value}
          onClick={() => onChange({ ...draft, kind: kind.value })}
        >
          <Icon name={artifactKindGlyph(kind.value)} size={16} />
          {kind.label}
        </button>
      ))}
    </fieldset>
  );
}

function ProjectChoice({
  draft,
  projects,
  onChange,
}: {
  draft: NewArtifactDraft;
  projects: readonly ArtifactChoice[];
  onChange: (draft: NewArtifactDraft) => void;
}) {
  return (
    <label className="new-view__field">
      <span className="new-type__legend">Project</span>
      <span className="select">
        <select
          className="field select__control"
          aria-label="Project"
          value={draft.project}
          onChange={(event) => onChange({ ...draft, project: event.target.value })}
        >
          <option value="">No project</option>
          {projects.map((project) => (
            <option key={project.value} value={project.value}>
              {project.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

function CopyChoice({
  draft,
  saving,
  onChange,
}: {
  draft: NewArtifactDraft;
  saving: boolean;
  onChange: (draft: NewArtifactDraft) => void;
}) {
  const count = draft.files.length;
  return (
    <div className="new-artifact__copy">
      <FileDrop
        label="Drop the page here"
        disabled={saving}
        onFiles={(files) => onChange({ ...draft, files })}
      >
        {count === 0 ? (
          <p className="new-artifact__note">{LINK_ONLY_NOTE}</p>
        ) : (
          <p className="new-artifact__note">
            <strong>Saving a copy</strong>: {draft.files.map((file) => file.name).join(', ')}
            <button
              type="button"
              className="new-artifact__clear"
              onClick={() => onChange({ ...draft, files: [] })}
            >
              Keep only the link
            </button>
          </p>
        )}
      </FileDrop>
    </div>
  );
}
