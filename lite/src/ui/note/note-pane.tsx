import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { createNoteFromLink, noteTitle, rankNoteSuggestions } from '../../application/index.ts';
import type { VaultPath } from '../../domain/vault/index.ts';
import type { EditorBridge } from '../editor/bridge.ts';
import { NoteEditor } from '../editor/note-editor.tsx';
import { useApp, type AppContextValue } from '../services.ts';
import { Icon } from '../shell/icons.tsx';
import { useUi } from '../state/ui-store.ts';
import { useVault } from '../state/vault-store.ts';
import type { Autosave } from './autosave.ts';
import { Backlinks } from './backlinks.tsx';
import { createNoteSaver, type NoteSaver } from './note-saver.ts';
import { NoteTitle } from './note-title.tsx';
import './note.css';

// markdown-it and DOMPurify load the first time a note is read, not at start.
const ReadView = lazy(() => import('../reader/read-view.tsx'));

const TAG_SUGGESTIONS = 12;

function editorBridge(app: AppContextValue, { autosave, opened }: NoteSaver): EditorBridge {
  const { services, actions, deps } = app;
  const index = services.session.index;
  const resolve = (target: string) => index.resolve(target);
  return {
    suggestNotes: (query) => rankNoteSuggestions({ query, notes: index.paths(), resolve }),
    suggestTags: (prefix) => {
      const wanted = prefix.toLowerCase();
      return index
        .tagCounts()
        .filter((tag) => tag.key.startsWith(wanted))
        .sort((left, right) => right.count - left.count)
        .slice(0, TAG_SUGGESTIONS)
        .map((tag) => tag.name);
    },
    resolves: (target) => resolve(target) !== null,
    createLinkedNote: (target) => {
      createNoteFromLink(deps, { target }).catch(actions.report);
    },
    followLink: (target) => {
      autosave
        .flush()
        .then(() => actions.followLink(target))
        .catch(actions.report);
    },
    openTag: (name) => actions.openTag(name),
    opened,
    changed: (read) => autosave.schedule(read),
    blurred: () => void autosave.flush(),
  };
}

/** Saves what is waiting when the page is hidden or closed, and when the note is left. */
function useFlushOnLeave(autosave: Autosave): void {
  useEffect(() => {
    const flush = () => void autosave.flush();
    const onHidden = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
      flush();
    };
  }, [autosave]);
}

function FavoriteToggle({ path }: { path: VaultPath }) {
  const { actions } = useApp();
  const isFavorite = useVault((vault) => vault.favorites.includes(path));
  return (
    <button
      type="button"
      className={`quiet-button note-star${isFavorite ? ' is-on' : ''}`}
      aria-pressed={isFavorite}
      aria-label={isFavorite ? 'Remove from favourites' : 'Add to favourites'}
      title={isFavorite ? 'Remove from favourites' : 'Add to favourites'}
      onClick={() => actions.toggleFavorite(path).catch(actions.report)}
    >
      <Icon name="star" filled={isFavorite} />
    </button>
  );
}

/** One note: its title, the editor or the rendered view, and what links here. Keyed by path. */
export function NotePane({ path }: { path: VaultPath }) {
  const app = useApp();
  const { services, actions, ui } = app;
  const [saver] = useState(() => createNoteSaver(app, path));
  const { autosave } = saver;
  useFlushOnLeave(autosave);
  const bridge = useMemo(() => editorBridge(app, saver), [app, saver]);
  const preview = useUi((state) => state.preview);
  const focusEditor = useUi(
    (state) => state.pendingFocus?.path === path && state.pendingFocus.target === 'editor',
  );
  // The tree changes when paths do: enough to notice this note was deleted or moved.
  useVault((vault) => vault.tree);
  // While reading, follow every change (a sync may pull new text); while editing, none.
  useVault((vault) => (preview ? vault.version : 0));
  const file = services.session.file(path);
  const resolves = useCallback(
    (target: string) => services.session.index.resolve(target) !== null,
    [services],
  );

  useEffect(() => {
    if (focusEditor) ui.setState({ pendingFocus: null });
  }, [focusEditor, ui]);

  if (file === null) {
    return (
      <div className="app-empty" role="status">
        There is no note at {path}.
      </div>
    );
  }

  return (
    <article className="note-pane" aria-label={noteTitle(path)}>
      <header className="note-header">
        <NoteTitle path={path} beforeRename={autosave.flush} />
        <div className="note-tools">
          <FavoriteToggle path={path} />
          <button
            type="button"
            className="quiet-button"
            aria-pressed={preview}
            title="Read or edit (⌘E)"
            onClick={actions.togglePreview}
          >
            <Icon name={preview ? 'pencil' : 'eye'} />
            <span>{preview ? 'Edit' : 'Read'}</span>
          </button>
        </div>
      </header>
      <div className="note-body">
        {preview ? (
          <Suspense fallback={<div className="read-view" />}>
            <ReadView text={file.text} resolves={resolves} onFollowLink={bridge.followLink} />
          </Suspense>
        ) : (
          <NoteEditor initialText={file.text} autoFocus={focusEditor} bridge={bridge} />
        )}
      </div>
      <Backlinks path={path} />
    </article>
  );
}
